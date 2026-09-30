# #267 — How orca, GitHub merge queue and Gas Town accept a completion or nomination

Question ([#267](https://github.com/lcsmas/orchestra/issues/267), map [#266](https://github.com/lcsmas/orchestra/issues/266)):
when a worker says its work is ready, what does each system **verify**, **refuse** and
**auto-trigger**? The answer feeds what a future `orchestra nominate` verb must enforce
(glossary: **Nomination**, **Candidate**, **Stage** — `CONTEXT.md`).

Sources, read 2026-09-30:

- **orca**: `stablyai/orca` @ `ed462b2c` (shallow clone). Paths below are relative to that repo.
- **Gas Town**: `steveyegge/gastown` @ `649b832b` (shallow clone). Paths below are relative to that repo.
- **GitHub merge queue**: the `github/docs` Markdown source on `main`, which renders to
  <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>
  and <https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue>.
- **Prior survey** (`~/.orchestra/audit-verified-fanout-2026-09-30/sota-research.md` §6, §8):
  reused only where re-read at source here. Its Gas Town summary ("batch + bisect") is
  **corrected** below.

Tags: **V** = VERIFIED (read at the cited source). **U** = UNVERIFIED.

---

## 1. Comparison table

| | orca `worker_done` (+ Dispatch authority) | GitHub merge queue entry | Gas Town `gt done` → MR bead → Refinery |
|---|---|---|---|
| **What is being accepted** | A **Task attempt settlement**, not a merge. `worker_done` carries `taskId`, `dispatchId`, `outcome`, optional `filesModified`/`reportPath`. No git ref at all. **V** | A **PR** (its head) that already passed the branch's protections. The queue then tests a *different* sha: a temp `gh-readonly-queue/{base}` branch = base + PRs ahead + this PR. **V** | A **branch + submitted `commit_sha`** written into an MR bead (`branch`, `target`, `source_issue`, `commit_sha`, `worker`, optional `pre_verified*`). **V** |
| **Verified at submission** | JSON payload; `taskId`, `dispatchId` present; `outcome ∈ {succeeded, failed}`; task and dispatch exist and match; sender **is the Dispatch's assignee** (pane key, or exact handle on legacy rows); sender is the **current process incarnation**; dispatch not `stopping`; no other live supervised Dispatch on the Task; the dispatch is the Task's current one. **V** | "Once a pull request has passed all required branch protection checks, a user with write access … can add the pull request to the queue" (required reviews and checks = entry precondition). "Merge when ready" before requirements pass = waits, then auto-adds. **V** | Caller is a polecat; exit status valid; branch ≠ default branch; **clean worktree**; **≥ 1 commit ahead** of base; branch not ≥ 200 commits behind (warn at 50; auto-rebase); **the pushed remote tip == the local HEAD sha** (unless `--skip-verify`); the MR bead is readable after write. **V** |
| **Refused (and how)** | The row is kept but converted to a rejection with a code: `invalid_payload`, `missing_task_id`, `missing_dispatch_id`, `invalid_outcome`, `unknown_task`, `unknown_dispatch`, `task_dispatch_mismatch`, `sender_not_assignee`, `inactive_dispatch`, `stale_dispatch`, `dispatch_inactive`, `worker_identity_changed`. A duplicate of an already-settled outcome is accepted idempotently (`duplicate: true`). **V** | Not addable until requirements pass. Removed from the queue on: failed required check on its merge group, conflict with base, CI timeout (counts as failure), manual/API removal, "branch protection failure that could not automatically be resolved". **V** Removal on a new push to the PR head: not stated in the pages read → **U**. | `gt done` exits non-zero (no MR) on any check above. The Refinery then **closes the MR as `rejected: …`** if: MR or source issue missing/closed, `commit_sha` missing or **changed**, branch/target/rig/source_issue changed, source issue not concrete, **source issue has unchecked acceptance criteria**, `no_merge` / `review_only` / `merge_strategy=local`. **V** (Go engine; see caveat §3.3) |
| **Auto-triggered on acceptance** | Atomic in one transaction: Task + Dispatch → `completed`/`failed`, **capability revoked**, dependents whose deps all completed → `ready` (`promoteReadyTasks`), earlier heartbeats suppressed, coordinator woken. **No** gate, **no** reviewer, **no** git check. `merge_ready` is a message type the coordinator **ignores**. **V** | A `merge_group` `checks_requested` event starts the **required CI** on the combined sha, **speculatively in parallel** (build concurrency 1–100). On green, the PR is merged FIFO, in batches bounded by min/max group size and a wait time. On red, the PR is dropped and the groups behind it are rebuilt. **No reviewer is triggered.** Review is a precondition, not a stage. **V** | Witness sees POLECAT_DONE and sends **MERGE_READY** to the Refinery. The Refinery (an LLM patrol, §3.3) rehearses a merge of the branch onto the target, runs setup/typecheck/lint/build/test, then merges and pushes. `gt mq post-merge` **proves the submitted `commit_sha` is reachable from the target** before closing the MR and source issue. **LLM quality review: off by default (`judgment_enabled=false`), and "recorded but do NOT gate merges"** even when on. **V** |
| **On failure** | `outcome=failed` settles the Task as failed. Retry is a new Dispatch, chosen by the coordinator. **V** | The PR leaves the queue, with the reason shown on its timeline. The author re-enqueues. **V** | Test/build failure caused by the branch → FIX_NEEDED mail to the polecat; the MR stays open and the branch is kept. Conflict → a new **conflict-resolution task** that the MR is blocked on. A pre-existing target failure → bug filed, merge proceeds. **V** |
| **Fast path** | — | — | `gt done --pre-verified` records `pre_verified_base` = target sha. The Go engine skips gates **iff target HEAD still == that base**. **V** |

---

## 2. orca — evidence

- `worker_done` is the terminal report. `--outcome succeeded|failed` is required, "never
  encode failure only in prose". It is sent "exactly once, from the dispatched terminal",
  and the worker checks its mailbox for a cancellation just before sending
  (`skill-guides/orchestration/references/worker-contract.md` §Completion; `skill-guides/orchestration.md`
  §Worker obligations). **V**
- The admission checks are, in order:
  1. `src/main/runtime/orchestration/lifecycle-reconciliation.ts:193-262`: payload, ids, outcome, task/dispatch existence and match, `hasLifecycleAuthority` (pane key, else exact handle at `:17-29`).
  2. `worker-report-admission.ts:29-48`: `stopping` → `dispatch_inactive`; a process not current → `worker_identity_changed`.
  3. `db/dispatch-context/worker-report-settlement.ts`: duplicate → idempotent accept at `:111`; already settled or a live sibling Dispatch → `inactive_dispatch` at `:135`/`:153`; not the latest → `stale_dispatch` at `:161`.

  **V**
- Rejections are persisted, not dropped: `convertLifecycleMessageToRejection` (`lifecycle-reconciliation.ts:308-318`,
  `send-point-to-point.ts:91-105`). The sender gets `lifecycle.action = 'rejected'` plus a code. **V**
- Atomicity: "worker_done wakes the Run only after its mailbox row, settlement, and replay
  receipt commit together" (`send-point-to-point.ts:142-151`). Capability revoked on settle
  (`worker-report-settlement.ts:185,216`). DAG promotion runs in the same transaction
  (`:283` → `db/tasks/task-store.ts:210-235`). **V**
- There is no merge semantics:
  - `coordinator.ts:193` and `lifecycle-reconciliation.ts:115` treat `merge_ready` as a no-op.
  - `reportPath` and `filesModified` are stored unvalidated. The only processing is a string-array type filter (`lifecycle-reconciliation.ts:270-274`). A grep of `src/main` and `src/cli` found no existence or git check on them.
  - The coordinator "never auto-resolves gates" (`coordinator-decision-gates.ts:53`). Gates are human decisions on a Task, not quality stages.

  **V** (the absence claims cover those two trees only)
- Review is **coordinator-routed, not triggered**: "A review-only `worker_done` authorizes
  synthesis of findings, not coordinator file edits"
  (`skill-guides/orchestration/references/coordinator-loop.md` §Review ownership). **V**

**Gist:** orca's acceptance is an *authority* check (is this the live owner of this attempt?)
with zero *content* check. Quality is left entirely to the coordinator's judgment.

## 3. GitHub merge queue — evidence

- Entry: "Once a pull request has passed all required branch protection checks, a user with
  write access … can add the pull request to the queue" (`data/reusables/pull_requests/merge-queue-overview.md`).
  "Merge when ready" is allowed before requirements pass; GitHub adds the PR once they are met.
  `gh pr merge` enables auto-merge instead when checks have not passed
  (`content/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue.md`). **V**
- The queue judges a **new sha**. Temp branches "contain a different `sha` from the pull
  request". The merge group = latest base + PRs ahead + this PR. CI must trigger on
  `merge_group` or the queue waits for checks that never arrive
  (`content/repositories/…/managing-a-merge-queue.md` §Configuring CI, §How merge queues work). **V**
- Refusals: "failed required status checks or conflicts with the base branch" → removed
  (`merge-queue-reject.md`). Removal reasons list: CI failures, timeout, user/API, "branch
  protection failure that could not automatically be resolved"
  (`merge-queue-removal-reasons.md`). **V**
- Knobs: build concurrency 1–100; "Only merge non-failing pull requests" (off = a failed PR
  may ride in a group whose **last** PR passed); status-check timeout; min/max group size
  plus a wait time. "Merge limits do not combine `merge_group` builds." Jump-to-top forces a
  full rebuild of in-flight groups (`managing-a-merge-queue.md`). **V**

**Gist:** the queue is purely *mechanical*. Human review and per-PR checks are **entry
preconditions**. The queue's own Stage re-runs the same required checks on the combined
state. It never adds a reviewer.

## 4. Gas Town — evidence

### 4.1 Submission (`gt done`, `internal/cmd/done.go`)

- Refusals (all `return fmt.Errorf`, no MR created):
  - not a polecat (`:676`); bad exit status (`:682`);
  - submitting the default branch (`:959`); uncommitted changes (`:979`);
  - zero commits ahead (`:1038`); ≥ 200 behind the base (`:1148`; warns at 50, then auto-rebases at `:1159`).

  **V**
- The verified push is checked "before creating any MR bead". "Branch-exists checks are
  insufficient: a stale remote branch can exist while the new commit never reached origin"
  (`:1438-1452`, `verifyPushedCommitWithBareFallback` at `:2081`). A failure goes to the
  Witness instead of creating an MR. **V**
- MR bead fields include `commit_sha`, `retry_count`, `conflict_task_id` and, with
  `--pre-verified`, `pre_verified_base` = the resolved target sha (`:1722-1753`). **V**

### 4.2 Acceptance (Go engine, `internal/refinery/engineer.go`)

- `recheckMRStillMergeable` (`:899-980`) and `recheckMRSourceStillMergeable` (`:997-1028`)
  run before the merge. Their refusals close the MR `rejected: <reason>` (list in §1),
  including "source_issue … has N unchecked acceptance criteria". **V**
- **Frozen Candidate**: `submittedBranchHead` (`:1478-1499`) refuses if the local branch
  head ≠ the submitted `commit_sha` ("source branch … changed from submitted head"). Remote
  and local branch deletion is done only "if at" that sha. **V**
- Pre-verified fast path: gates are skipped only if `origin/<target>` == `PreVerifiedBase`
  (`:1332-1346`). **V**
- Failure routing (`HandleMRInfoFailure`, `:1566+`):
  - slot timeout → retry;
  - policy ineligible → close;
  - PR awaiting human approval → retry next poll;
  - branch missing → escalate to the mayor;
  - otherwise nudge the polecat `MERGE_FAILED … fix and resubmit` plus the mayor, and on conflict create a conflict task that the MR depends on.

  **V**

### 4.3 Caveat — what actually runs, and the README's batch-bisect claim

- README (`README.md:651-661`): "Refinery batches pending MRs … If red: bisects". The Go
  implementation exists (`internal/refinery/batch.go:202-300`: max batch 5, retry once for
  flakiness, then bisect). **V**
- But at `649b832b`, **no non-test Go code calls `ProcessBatch`, `ProcessMRInfo`,
  `HandleMRInfoSuccess` or `HandleMRInfoFailure`** outside `internal/refinery/` itself. The
  only external `Engineer` calls are `LoadConfig`, the `List*MRs` listings, `ClaimMR` and
  `ReleaseMR`. **V** (grep over `*.go` excluding `_test.go`; the positive control
  `recheckMRStillMergeable` has 7 hits)
- The production Refinery is an **LLM patrol** driven by
  `internal/formula/formulas/mol-refinery-patrol.formula.toml`. It merges "one at a time
  without rewriting submitted heads" (`:4`). Its steps:
  - `queue-scan` (`:252`): `gt mq list`, fail closed on unknown PR state;
  - `process-branch` (`:327`): `git merge --no-ff origin/<target>` rehearsal on a temp branch, conflict → task;
  - `run-tests` (`:424`): setup/typecheck/lint/build/test, `run_tests` default true;
  - `quality-review` (`:469`): off by default, measurement-only;
  - `handle-failures` (`:541`): "VERIFICATION GATE … You CANNOT proceed to merge-push without all checks passing OR a bead filed for the pre-existing failure";
  - `merge-push` (`:610`): verify local == remote sha after the push; in `pr` mode, `require_review` needs `reviewDecision == APPROVED`.

  **V**
- The formula merges `origin/<polecat-branch>` (the **tip**) and never mentions
  `commit_sha` (0 hits). The sha pin is enforced **after** the merge, by `gt mq post-merge` →
  `verifyMQPostMergeProof` (`internal/cmd/mq.go:600-618`): the submitted sha must be
  reachable from the target. **V** Inference (not tested): a tip that moved *past*
  `commit_sha` still passes that proof, so in the LLM path the Candidate is pinned from
  below, not frozen. **U**
- Correction to the prior survey: "Gas Town = mechanical batch+bisect" describes code that
  is not wired in. The operative queue is serial, LLM-executed, with mechanical checks at
  submit time and post-merge.

---

## 5. Implications for `orchestra nominate`

Restated target: `nominate` is how a worker files a **Nomination** of a **Candidate**
(a frozen ref) so every **Stage** judges that exact ref. What must the verb itself enforce,
and what may it trigger?

**Must enforce at the verb (refuse, with a persisted, coded rejection):**

1. **Authority = orca's model, on our capability token.** Only the live assignee of the
   dispatch may nominate. Refuse a superseded or settled dispatch, or a changed process
   identity. Treat a duplicate as idempotent. Orchestra already fail-closes `worker_done`
   on the #129 token (`src/cli/bus-verbs.ts:452,550-572`). `nominate` should reuse that path,
   not add a second authority scheme.
2. **Candidate = (branch, sha), and the sha is verified on origin.** Store the sha, not
   the branch name. Refuse if `origin/<branch>` ≠ the stated sha: Gas Town's "branch-exists
   is insufficient" lesson. Refuse a dirty tree, zero commits ahead of the base, or the
   default branch.
3. **Freeze, don't pin from below.** Every Stage reads the stored sha. If the branch tip
   moves, the Nomination is **void** and must be re-filed (the Gas Town Go engine's
   `submittedBranchHead`). Do not copy the LLM-path post-hoc reachability check, which
   admits later commits. GitHub reaches the same end by judging a queue-made sha.
4. **Structured outcome, not prose.** An explicit field (orca `--outcome`), plus the base sha
   the worker verified against. This allows a Gas Town–style fast path: a verifier Stage may
   skip re-running a check only if the target has not moved since that base.
5. **Ticket eligibility.** Refuse when the linked ticket is closed, or has unchecked
   acceptance boxes (Gas Town `HasUncheckedCriteria`). This is cheap and catches "done but
   not done".

**Auto-trigger (the verb's side effects):**

6. **Mechanical Stage only by default.** None of the three systems auto-spawns an LLM
   reviewer on acceptance. orca triggers nothing; GitHub runs required CI; Gas Town's LLM
   review is off by default and non-gating. Enqueuing the Candidate for the verifier gate
   (queue design: [#263](https://github.com/lcsmas/orchestra/issues/263)) is the precedented
   trigger. An auto-dispatched adversarial reviewer would be **novel**: justify it with
   [#265](https://github.com/lcsmas/orchestra/issues/265)'s catch-per-cost numbers, not precedent.
7. **Keep completion and nomination distinct.** orca settles the task on `worker_done` and
   ignores `merge_ready`. Gas Town couples them (`gt done` = push + MR). For Orchestra, a
   task can settle (`worker_done`) without a Candidate (research, review). `nominate` is
   the merge-intent act and should be a separate, sha-carrying row.
8. **Failure routing as data.** When a Stage refuses, the Nomination leaves the queue with a
   typed reason (tests / conflict / ineligible). It goes back to the nominator. A conflict
   becomes a dependent task (Gas Town), and the base is never silently rebased onto (GitHub
   builds a temp ref, Gas Town merges `--no-ff` "without rewriting submitted heads").

**Not supported by any source read:** blocking a nomination on an LLM opinion; allowing a
nomination without a sha; accepting a nomination whose rejection is not persisted.

## 6. VERIFIED / NOT VERIFIED

- VERIFIED: every `file:line` above, read at orca `ed462b2c` / gastown `649b832b` and the
  `github/docs` `main` source. The Gas Town "no non-test caller" claim comes from grep with a
  positive control.
- NOT VERIFIED:
  - whether a push to a queued PR's head removes it from the GitHub queue;
  - whether Gas Town's LLM path admits a tip moved past `commit_sha` (inferred from code, not run);
  - Gas Town's runtime behaviour in general (docs and source only, no instance run);
  - orca behaviour beyond `src/main` and `src/cli`.
