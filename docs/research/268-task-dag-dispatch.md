# #268 — How task-DAG orchestrators handle dependent dispatch, re-plans and rebases

Researched 2026-09-30 for wayfinder map #266. Question (issue #268): in orca, Claude Code
agent teams, Beads/Gas Town and Cursor's planner→worker design, how does a dependent task
start (upstream done vs merged)? How does it build against an unmerged interface? What
happens when the upstream is re-planned or its interface changes? Who rebases?

**Evidence labels.**
- **V**: I read it at the primary source (URL fetched 2026-09-30, or a local path).
- **V\***: a research sub-agent read it at the named commit and `path:line`; I did not re-read it.
- **U**: UNVERIFIED, meaning an inference or a claim that couldn't be traced to source.

Pinned sources:
- orca `stablyai/orca@ed462b2c`
- Beads `steveyegge/beads@1d637e12`
- Gas Town `steveyegge/gastown@649b832b`
- Claude Code: https://code.claude.com/docs/en/agent-teams
- Cursor: https://cursor.com/blog/scaling-agents and https://cursor.com/blog/self-driving-codebases

## Verdict

- **Only Gas Town gates a dependent on MERGED work.** Orca, Claude Code teams and Beads unblock
  on the upstream's *self-reported* completion. Cursor dropped the dependency graph and has no
  gate at all.
- **None of the five models an interface change or a re-plan of the upstream.** A completed or
  closed upstream that later changes or reopens never invalidates work its dependents have
  already built. Beads re-blocks the tracker row but doesn't touch the built work.
- **Nobody builds on an unmerged upstream branch by design.** Each system uses one of three
  shapes:
  - a shared tree: orca's default, and Claude Code teams by inference;
  - a fresh base from main or an integration branch: Gas Town, orca's `new-child`;
  - one shared branch everyone pushes to: Cursor.

  Orchestra's current rule (build against a frozen-interface stub, rebase after the upstream
  merges) is a fourth shape, and none of the surveyed systems has it.
- **Rebase ownership splits two ways.** Gas Town has a dedicated merger (Refinery), which sends
  conflicts back to the worker as a task. Cursor puts it on the worker and removed its
  integrator. Orca, Claude Code and Beads have no merge or rebase role at all.

## Mechanism table

| System | Dependent start trigger | Unmerged interface | Upstream re-plan / interface change | Who rebases / merges | Reported failure modes |
|---|---|---|---|---|---|
| **orca** | Task goes `ready` when every dep is `completed`. `promoteReadyTasks` runs on `worker_done --outcome succeeded` or on a manual status change. There is no git/merge/PR check: "completed" is the worker's own report. Dispatch is manual: the coordinator polls `task-list --ready`. **V\*** | Default placement `--worktree current` shares the coordinator's tree, so there is no per-task branch. `new-child` bases on `--base-branch`/default, never on the upstream's branch. Only guard: a preamble telling the worker to "git pull --rebase <base> or escalate". **V\*** | Failed/cancelled upstream: dependents stay `pending` until a `--retry-of` replacement completes. No cascade or demotion: any status can go to any status, so completed→failed leaves dependents ready or dispatched. `task-update` edits only status/result, so a spec or dep change isn't modelled. **V\*** | Nobody. The `merge_ready` type is ignored and the `merging` phase is declared but never entered. **V\*** | A stuck DAG only produces a log line. 3 consecutive failures trip a per-task circuit breaker. A hung worker is warned after 10 min without a heartbeat, never auto-failed. Nested depth defaults to 1; docs: prefer waves over chains deeper than 3–4. **V\*** |
| **Claude Code agent teams** | "a pending task with unresolved dependencies cannot be claimed until those dependencies are completed". Unblocking is automatic when a teammate completes the upstream, and teammates self-claim. **V** | Not specified. "Two teammates editing the same file leads to overwrites" suggests one shared tree (**U**, inference). No branch/merge/worktree concept in the teams doc. **V** | Nothing documented: no invalidation or re-plan hook. A `TaskCompleted` hook can refuse completion (exit 2). **V** | No merge role. Worktrees are pointed to as the *manual* alternative. **V** | "Task status can lag: teammates sometimes fail to mark tasks as completed, which blocks dependent tasks". "The lead can stop early". Teammates "stop after encountering errors". "For sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more effective." "No nested teams". **V** |
| **Beads** (`bd`) | Unblocks when the blocker is CLOSED. Dep types: `blocks`, `parent-child`, `conditional-blocks` (runs only if the upstream fails), `waits-for`. Claims are atomic (`--claim`). **V\*** | Not handled. Beads is an issue tracker, not a VCS layer. **V\*** | Reopening an upstream re-blocks dependents in the tracker. Work already built is untouched (**U**, inference). No interface model. **V\*** | Nobody. There is only a "merge slot" mutex. **V\*** | A stale blocked flag can hide ready work (`bd recompute-blocked` exists for this). **V\*** |
| **Gas Town** (on Beads) | **Only system gated on merge.** Refinery rebases and merges, then closes the issue as "Merged in <MR>". The convoy dispatcher's `merge-blocks` requires that close reason. **V\*** | Never. A polecat worktree starts from `origin/main` or from an epic integration branch, so dependents see only merged work. Docs: cross-child deps are "risky — depends on merge order" unless the children share an integration branch. **V\*** | No re-plan or interface-change mechanism found (grep: 0 hits). **V\*** | Refinery (an LLM agent). On conflict it sends the worker a conflict-resolution task that blocks the MR. Per #267 research, the batch-then-bisect code is only called from tests; the live Refinery merges one MR at a time. **V\*** | The dependency check fails open ("on error assume not blocked"). Stale claim timeouts. Conflict beads rot as open issues. **V\*** |
| **Cursor** (planner → worker → judge) | No gate. An early "dependency graph of major work that agents could take up in parallel", with agents "manually spawned … and nudged", gave results that "weren't much better". It was replaced by recursive planners that create tasks continuously. **V** | Workers "work on their own copy of the repo, and when done, they write up a single handoff". Pushing to one shared branch is **V\*** (sub-agent reading, not re-read). | Planners re-plan continuously: "even if a planner is 'done,' it continues to receive updates, pulls in the latest repo, and can continue to plan". Interface breakage is tolerated and fixed forward: "we accept some moments of turbulence and let the system naturally converge". **V** | Workers: "Workers were already capable of handling conflicts themselves". The integrator "created more bottlenecks than it solved". **V** | Locking: "Twenty agents would slow down to the effective throughput of two or three". "100% correctness before every single commit … caused major serialization"; a "green" branch gets snapshots plus a fixup pass. "Periodic fresh starts to combat drift and tunnel vision." **V** |

Supporting source for the next section:

- "Passes Alone, Fails Together" (Xia, Wu, Park), https://arxiv.org/abs/2609.25396.
- Interference was 1 in 834 runs on 417 real Django PR pairs, against 97% on constructed
  interface-change tasks. "A message describing the completed concurrent change recovered 82%
  of runs." **V** (abstract only).

## What Orchestra does today

- **No task/DAG table on the bus.** The bus schema (`src/main/bus.ts` ~l.169–250) holds only
  `runs`, `messages`, `deliveries`, `cursors`, `decision_gates` and `mirror_records`.
  Dependencies live in the OPS's head and the ledger prose. **V**
- **Rules are in the `verified-fanout` skill** (`~/.claude-mc/skills/verified-fanout/SKILL.md`),
  and nothing enforces them. **V**
  - l.327–332: "A dependent track starts at dispatch, not at its upstream's merge. Freeze the
    shared interface … the dependent builds against a stub … nominates only after the
    upstream merges and it rebases."
  - l.198: gate the dependent LAST (eight rebases measured, six changing only the parent sha).
  - l.455–458: serialize merges on a shared seam, and each remaining track rebases onto the
    new tip.
- **Measured cost of getting it wrong.** Audit 2026-09-30
  (`~/.orchestra/audit-verified-fanout-2026-09-30/audit-verified-fanout.md`, row "Pistes
  bloquées sur une autre"): tracks **B5 234, C3 208, C4 236 min** blocked on an upstream,
  i.e. **208–236 min** idle per dependent track. **V** for the table row. The underlying
  latency audit (tidy-lynx `82e52311`) was not re-read: **U** for the method.

## Implications for an Orchestra Bus task DAG

Terms follow CONTEXT.md. **Vague** = a run coordinated by an OPS. **Nomination** = a worker's
claim that a ref is ready to gate. **Candidate** = the frozen ref a nomination names.

1. **Make the start trigger a separate event from the nomination trigger.** No surveyed system
   separates them: each gates start on completion or on merge, and nothing gates what gets
   nominated. Orchestra's stub rule needs both:
   - `dispatchable` when the upstream's **interface is frozen**, which is a ledger/bus fact and
     not a task status;
   - `nominable` only after the upstream's **Candidate merged** and the dependent rebased onto
     it.

   A bus `depends_on(ticket, upstream, gate = interface_frozen | merged)` edge with those two
   gates would turn the skill prose into a checked rule. It would recover most of the 208–236
   min: only the stub-to-rebase delta remains serialized.
2. **Gate "merged" on the merge event, not on a self-report.** Gas Town is the only surveyed
   system that avoids the "task status can lag" failure (Claude Code) and orca's
   "completed = worker says so". It keys on the actual merge (close reason "Merged in"). The
   Orchestra equivalent: the edge resolves on the OPS's merge record of the upstream
   Candidate sha, never on `worker_done`.
3. **Model interface change explicitly, because nobody else does.**
   - The frozen interface is a versioned bus artifact.
   - An upstream re-plan that bumps it re-opens the edge for every dependent and posts one
     "what changed" message to each. The arXiv 2609.25396 result makes this cheap and
     effective: 82% recovery on interface-change interference.
   - Orca's no-demotion trap shows the failure to avoid: a later status change left dependents
     dispatched against a dead upstream. Beads' `recompute-blocked` shows the other failure:
     derived flags go stale. Derive readiness at read time and don't cache it.
4. **Keep the rebase on the dependent worker, serialized by the OPS.** Cursor's integrator and
   Gas Town's one-at-a-time Refinery both became the bottleneck. The worker rebases its own
   stub-built branch when the edge flips to `merged`, then nominates. The OPS only orders
   merges on a shared seam (existing rule). A dependent's Candidate made before the upstream
   merged is invalid by construction and should be refused at nomination.
5. **Fail closed on unknown dependency state.** Gas Town treats a lookup error as
   "not blocked". For Orchestra an unreadable edge should mean "not nominable" and escalate,
   in line with the bus's existing unknown-is-not-gone stance.
6. **Don't copy Cursor's no-gate model for Orchestra's quality bar.** Its fix-forward
   green-branch model trades per-commit correctness for throughput. That trade is deliberate
   there and contradicts Orchestra's gated-Candidate model. Only the throughput lesson
   transfers: don't serialize dispatch on merge.

## NOT VERIFIED

- Every **V\*** row: orca, Beads and Gas Town `path:line` claims were read by a sub-agent at
  the pinned shas and not re-read by me.
  - orca paths cited by the sub-agent: `task-store.ts:59-66,210-235`,
    `worker-report-settlement.ts:282-283`, `task-dispatch-refusal.ts:48-60`,
    `worktree-create-base.ts:8-29`, `preamble.ts:226-238`, `lifecycle-transition.ts:70-78`,
    `lifecycle-reconciliation.ts:115`, `coordinator.ts:29`, `nested-worker-depth.ts:8`,
    `recovery-and-cleanup.md:139-145`.
  - Gas Town paths: `work_bead_close.go:77`, `convoy/operations.go:181-186,217,235-237`,
    `manager.go:781-788`, `integration-branches.md:43-59,126`, `engineer.go:107,186`.
  - Beads paths: `docs/core-concepts/dependencies.md:24-25`, `blocked.go:30`,
    `coordination.md:125-127`, `CLI_REFERENCE.md:4293-4299`.
- orca: the retirement of the auto coordinator loop was inferred from its test, not its code.
  Whether `--retry-of` re-checks deps is unknown.
- Claude Code teams sharing one working tree is an inference from the "overwrites" sentence.
- Cursor pushing to one shared branch: sub-agent reading, not re-quoted by me.
- Gas Town's "Refinery merges one MR at a time in production" comes from #267's research.
- The 208–236 min idle figure: the audit table row was read, but the latency method behind
  it wasn't.
- Implication 1's "recovers most of the idle time" is a projection, not a measurement.
