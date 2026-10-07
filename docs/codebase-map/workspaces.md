# Workspaces subsystem

The core of Orchestra. `src/main/workspaces.ts` (~2650 lines) owns the full
workspace lifecycle, worktree mechanics, hook installation, agent spawning, and
inter-agent orchestration. Supporting files: `store.ts`, `scripts.ts`,
`secrets.ts`, `repo-sync.ts`, and `sandbox-import.ts` (import/eject/backup —
see [sandbox-transport.md](sandbox-transport.md)). Domain types:
`src/shared/types.ts`.

## What a workspace is

`Workspace` interface — `src/shared/types.ts:3-136` (read it; richly commented).
A workspace is an isolated execution environment for one Claude Code agent.
`kind` (`types.ts:23`) selects one of three:

- **`worktree`** (default / absent) — a real `git worktree` cut from a repo's
  base branch. Has `repoPath`, `worktreePath`, `branch`, `baseBranch`; supports
  diff/merge/PR/release tracking.
- **`scratch`** — throwaway non-git dir under `~/.orchestra/scratch/`.
  `repoPath`/`baseBranch` are `''`; `branch` is a display label only. Creation
  pins `accountId` to the account flagged `scratchDefault` (if any —
  `scratchDefaultAccountId`, `accounts.ts`), since there's no repo to take an
  account from; the checkbox lives in the Accounts settings.
- **`orchestrator`** — a scratch session seeded with a coordinator brief
  (`ORCHESTRATOR_BRIEF`, ~`workspaces.ts:351`); children it spawns carry its id
  as `parentId` and nest under it in the sidebar. The brief is one-time
  onboarding only — durable role enforcement is the SessionStart-injected
  `orchestrator-instruction.sh` reminder (re-fired post-compaction) plus the
  `orchestrator-guard.sh` PreToolUse deny hook (see
  [hooks-cli-socket.md](hooks-cli-socket.md)), both gated on `ORCHESTRA_KIND`
  env or the `.orchestra/.orchestrator` sentinel (`markOrchestratorWorktree`,
  written at creation and by `/promote` so a mid-session promotion picks it up
  without a pty restart; `unmarkOrchestratorWorktree` removes it on `/demote`).
  The sentinel's **contents** select the reminder wording: `dual` (written when
  a *worktree* is promoted) yields a dual-role reminder — coordinate children
  *and* keep doing this branch's own work — while anything else (`1`, and every
  historic sentinel) yields the absolute "you do not implement" text. The
  PreToolUse guard needs no such split: it already allows writes inside the
  workspace's **own** worktree and blocks only edits to *other* workspaces'
  files, which is exactly the dual-role contract. Both the brief and both
  reminder variants carry the delegation loop's **close** as well as its open:
  every child must end LANDED (verified with `orchestra verify-landed`, see
  `dispatchVerifyLandedRequest` below) or **INTENTIONALLY UNMERGED** (a
  spike/experiment whose brief forbade merging, recorded as such) — only the
  silent third state is forbidden. They also carry the sanctioned
  **sub-orchestrator** move — spawn a child, `orchestra promote <child-id>`,
  at most one such level, checkable via `orchestra whoami` (the only in-band
  way an agent learns its own `parentId`) — so model-initiated recursion is a
  documented pattern, not an accident of the attach machinery.

Use the helper **`isScratchLike(ws)`** (`types.ts`) instead of comparing `kind`
to a literal. It asks **"does this own a git checkout?"**, not "what kind is
this?" — the rule is conjunctive: `'scratch'` is always scratch-like, and
`'orchestrator'` is scratch-like only *while repo-less*. Deliberately not a bare
`!ws.repoPath`: `teardownWorkspace` branches on this to choose between `rm -rf`
of a directory and `git worktree remove` against a repo, so keeping `kind` as
the primary gate means only the paths that mint a workspace can change that
answer. A scratch record carrying a stray `repoPath` is still scratch-like, and
that case is asserted in `shared/workspace-predicates.test.ts` so the predicate
cannot be "simplified" back.

### An orchestrator can adopt a real checkout

`orchestra adopt-repo <id> <repoPath> [--base <branch>]` →
`/adoptRepo` → **`dispatchAdoptRepoRequest`** (`workspaces.ts`) gives a
repo-**less** orchestrator a real worktree, so its agent can read the repo it
coordinates — docs, notes, scripts, and the repo's git-tracked
`.claude/skills` project skills. That last one is the motivating case: project
skills are discovered from the agent's **cwd only** (`sdkListSkills` pushes
`<worktreePath>/.claude/skills`; Orchestra passes no skills flag to CLI or SDK
and there is no redirect mechanism), so nothing short of a checkout reaches them.

`kind` stays `'orchestrator'` — the coordinator identity (pinned section, brief,
`orchestrator · ` name prefix) is kind-carried and survives. What changes is that
`isScratchLike` goes false, so every git path treats it as the worktree it owns.

Three invariants that are not interchangeable:

- **Worktree first, store write second.** A record whose `repoPath` is set while
  its `worktreePath` is untracked by git is exactly what
  `pruneOrphanedWorkspaces` hard-deletes on the next launch, so that combination
  must never be observable. Everything before the single `upsertWorkspace` is
  reversible by doing nothing.
- **The checkout lives under `ORCHESTRA_ROOT`**, never `SCRATCH_ROOT` — the
  latter's only teardown rule is a plain `rm -rf` (`teardownWorkspace` confines
  it there), and prune + size accounting scan only the worktree root.
- **The transcript directory is carried across.** Both drivers key it on
  `mangleProjectDir(worktreePath)` (`agent-sdk.ts` `transcriptDir`), so moving
  the directory would orphan the conversation of the very session adopting.

After adoption `repoPath` supersedes any `repoAssociation` for grouping, `/spawn`
inherits the repo (real ownership, unlike an association), and `/demote` becomes
available: it sheds the *kind* to `'worktree'`, the inverse of promote's two
routes.

### Orchestrator: a KIND *and* a capability

"Orchestrator" is two separable things — a **tree role** (children may nest
under me) and a **non-git nature** (no repo/branch/diff). The `'orchestrator'`
kind fuses both, which is right for a repo-less coordinator but wrong for an
integration branch that coordinates agents *while carrying its own commits*. So
a git worktree becomes a coordinator via the **`canOrchestrate?: boolean`**
capability (`types.ts:86`) instead: `kind` stays `'worktree'` and every git path
keeps working.

Two helpers, two questions — do not conflate them:

| Helper | Question | Promoted worktree |
|---|---|---|
| `isScratchLike(ws)` `types.ts:246` | is this **non-git**? (diff/merge/PR/delete/rename) | **false** |
| `canOrchestrate(ws)` `types.ts:261` | can children **nest under** this? (tree/parent) | **true** |

They diverge exactly on a promoted worktree, and that divergence *is* the
feature. Flipping such a worktree's `kind` instead would make `isScratchLike`
true and silently strip its git identity: `teardownWorkspace` (`:566`) returns
early and never calls `removeWorktree` (the git worktree **leaks**),
`renameWorkspaceBranch` (`:823`) stops running `git branch -m` (label desyncs
from the real branch), and both frontends hide Diff/Run/PR/merge/branch-picker.

### Repo ASSOCIATION ≠ `repoPath`

A repo-less orchestrator can be filed under a repo's sidebar section (so a
coordinator sits with the children it coordinates) via
**`repoAssociation`** (`types.ts`, set by `/setRepoAssociation` —
`orchestra set-repo <id> [<path>]`). It is a **display-only** grouping key: the
orchestrator keeps `repoPath: ''`, gains no branch/diff/merge/PR, and `/spawn`
**deliberately** does not inherit it (a bare spawn from a coordinator must still
name `--repo`, or a sidebar preference would silently decide where code lands).

Filling in `repoPath` **without creating the checkout** looks equivalent and is
not — several git paths treat a non-empty `repoPath` as "owns a checkout".
Sharpest: `pruneOrphanedWorkspaces` buckets by `repoPath`, and a scratch dir is
never in `git worktree list`, so the record would be **hard-deleted from the
store on the next launch** (measured: with `repoPath` filled and no kind guard,
the record is dropped). The bucketing loop now skips `isScratchLike` records on
their KIND, closing that trap for any future repo-ish field.

Note the hazard is the **missing checkout**, not the field: `adopt-repo` above
sets `repoPath` legitimately, because it creates the worktree first. What stays
forbidden is promoting this display-only preference into `repoPath` without
materializing one. Once a coordinator has adopted a repo, `repoPath` supersedes
any association for grouping and `/setRepoAssociation` refuses it (a second key
could only disagree with where its checkout actually is).

Three pollers were widened from `kind === 'scratch'` to `isScratchLike` in the
same change (`activity.ts` merge-state / branch-name / release-state and
`api-handlers.ts` `findPR`) — a pre-existing hole where an orchestrator reached
`gh` and `git` calls for a branch that is not in the repo.

Key per-record fields: `accountId` (pinned at creation, never changes —
preserves `claude --continue` history), `parentId` (nesting), `port`
(auto-allocated dev-server port), `setupStatus`, `branchManuallySet` (rename
lock), `divergedFromBase`/`mergedAt`/`unpushedAhead`/`releasedVersions`
(sidebar pills), `contextTokens` (badge seed), `heavyResumePending` (suppresses
blind Enter during a heavy `claude --continue` resume), `markedUnread`
(manual come-back-later bookmark, toggled from the sidebar via
`workspaces:setUnread`, auto-cleared on next selection), and **`host`**
(`WorkspaceHost`, `types.ts:69` — absent = local node-pty; `{kind:'sandbox',
endpoint}` = agent lives in an always-on container, see
[sandbox-transport.md](sandbox-transport.md)).

## Lifecycle

### Create
- **`createWorkspace(input, window)`** — `workspaces.ts:259`. Steps: ensure root →
  generate UUID + `randomBranchName()` (adjective-noun, ~`:236`) → `createWorktree`
  (git.ts) → `installOrchestraHooks` → `store.allocatePort()` → build record,
  **pin repo's `accountId`** (~`:297`), record `parentId` only if parent exists
  (~`:302`) → persist + broadcast `workspace:update` → fire setup script async
  (does NOT block) → does NOT spawn the PTY (renderer's `pty:start` does, once it
  has terminal dimensions).
- **`createScratchWorkspace`** / **`createOrchestratorWorkspace`** —
  `workspaces.ts:403` / `:407` (both wrap `createScratchLikeWorkspace`, `:361`).

### Setup (repo workspaces only)
- **`runSetupScript(id, window)`** — `workspaces.ts:583`. Sets `setupStatus`
  `pending→running→ok|failed`, runs via `runOneShot` (scripts.ts), captures last
  stderr line into `setupError`. Log: `~/.orchestra/scripts/<id>-setup.log`.
  Failure never blocks creation; UI offers retry.

### Start agent
- **`startAgentPty(ws, cols, rows, window)`** — `workspaces.ts:2299`. Heavy-resume
  gate (sets `heavyResumePending` when resuming a >100k-token session),
  orchestrator brief on first launch only, idempotent hook
  reinstall, account-config sync, env build (`ORCHESTRA_BRANCH`,
  `ORCHESTRA_BRANCH_AUTO`, `ORCHESTRA_KIND`, per-repo `CLAUDE_CONFIG_DIR`), then `startPty` with
  `claude --dangerously-skip-permissions` (or `--continue` if `hasInput`).
  **Sandbox-hosted** (`ws.host?.kind==='sandbox'`): skips the local hook
  install, uses cwd `SANDBOX_WORKSPACE_DIR` (`/workspace`), and **strips
  `CLAUDE_CONFIG_DIR`** (a host path would shadow the container's seeded
  login); `startPty` routes to the remote transport via `ws.host`.
- **`startWorkspaceAgentHeadless(id)`** — `workspaces.ts` (used by spawn **and by
  Restart's retry**, below). Starts the delegated agent as an SDK session via the
  `sdk-delivery.ts` seam (`sdkStartAndDeliverResult` → agent-sdk's `sdkWake`/`sdkSend`),
  enqueuing `lastTask` as the opening turn, and returns `SdkStartResult` (`sdk-delivery.ts`)
  (`{ok:true, note?}` | `{ok:false,error}`). **No PTY fallback (#227):** when the SDK
  session cannot start (`ensureSession` throws — SDK not loadable, worktree
  missing, env build failure, `query()` construction), the workspace is KEPT,
  stopped, `lastTask` retained, `hasInput` and `openingTaskDelivered` unset (= "task
  still owed", `owesOpeningTask`, `src/shared/opening-task.ts`), and the reason is an
  `error` row in its Agent view — emitted live AND persisted (`ws.sdkStartErrors`, capped 5;
  `sdkHistory` returns them even with no transcript, the renderer drops a history row its live
  fold already holds — `dropLiveErrorEchoes`), so a reload or app restart still explains why the
  child is stopped. **D6/D7 — bounded first-TURN wait:** after a successful start it waits (20 s,
  `ORCHESTRA_SPAWN_INIT_WAIT_MS` overrides for tests) for the session's FIRST TURN OUTCOME
  (`sdkAwaitFirstTurn`, settled in agent-sdk `consume` via `shared/first-turn.ts classifyTurnMessage`):
  init alone decides NOTHING (a bad `--model` / no auth inits, then errors — measured on claude
  2.1.284: init → assistant `{error, is_api_error_message, model:"<synthetic>"}` → `result is_error`;
  the CLI then STAYS ALIVE — it exits 1 only at stdin EOF, so a stub that exits models the one-shot harness, not the SDK's open stdin —
  fixture `scripts/fixtures/real-cli-badmodel-2.1.284.jsonl`). First non-error assistant/tool
  output → ok at once; an errored turn (`failFirstTurn`) or the CLI exiting before any output →
  not-ok naming the error/exit and the model, the queued brief unwound (owed again, no stale
  pending-prompt entry), the init-persisted `sdkSessionId` cleared (else the workspace would read
  "already ran"), the reason persisted as ONE error row, and the errored session STOPPED (child kept
  stopped: spawn's own `sdkStopIfLive`, or `failFirstTurn` itself when NO waiter holds it — a failure past the
  bound, a wake); an interrupted / stopped first turn (`shared/first-turn.ts isIntentionalEnd`: stop, Restart,
  /clear, hibernate, user interrupt) is NOT a failed start; still silent at the bound → ok WITH
  `note: "first turn not confirmed within 20 s — started, not confirmed"` (the note names the SIGNAL D7 waits for, not init) (never a failure — the #176 slow-init
  class; the brief is NOT marked delivered until the output lands, so a CLI that then dies leaves it owed — `slow_then_die`). **What the wait catches
  / does not:** caught = a CLI that exits before output and one that errors its first turn (the no-credentials shape above);
  NOT caught inside the wait = a live CLI that only RETRIES (`system/api_retry`, e.g. a dummy key: init after the message, then 401
  retries, process alive — measured 2026-09-30): spawn answers ok + the note and the brief stays unmarked; a later errored end still
  unwinds it via `failFirstTurn`. Restart carries the note (`RestartResult.note`; the CLI prints it instead of "delivered").
  Single-flight per workspace (`openingTaskStarts`) and guarded by `owesOpeningTask`; **across sends** the `sdkSend` claim holds
  `session.briefGate` until the brief is queued — every other send waits (the brief is FIRST) and a send whose text IS the in-flight
  brief (Restart racing a composer send, either order) is answered with the claimant's turn instead of being sent again — so the
  brief reaches the CLI **once**. That dedupe is opt-in (`dedupeOpeningBrief`: only spawn / Restart's own `sdkStartAndDeliverResult(…,
  { openingBrief: true })`), so a user's identical message is never swallowed. An INTENTIONAL end of a session that never delivered the brief
  (stop, Restart, boot-wedge recycle, hibernate) KEEPS its pending-prompt copy — Restart-fresh (`recoverPendingPrompts`) and
  `recycleSession` re-read it to redeliver; only a crash drops it. The view-open recovery (`recoverPendingPromptsInner`) sends that copy
  with the same dedupe when its text is `lastTask` (r4), so it and a racing wake's claim are ONE delivery. `session.owedBrief` is dropped when the CLI speaks before any claim (a keeper reattach). Start
  errors that predate a session are cleared at its first non-error output (`clearStaleStartErrors`); the bus-wake roster skips a kept
  child that `startKeepsFailing` — owed + a failed start, or the SAME error `START_FAIL_STREAK` (3) times in a row within
  `START_FAIL_WINDOW_MS` (10 min — a transient cause stops blocking once it is gone) even for a child that ran once; never a LIVE session — so
  Restart / a direct message retries, not every sweep. Restart takes the owed route for a stopped owed child AND for a live one whose OWN first
  turn failed (`restartOwesOpeningTask`, `live.sdkFailed` from the seam `firstTurnFailed`); a live hung start restarts normally.
- **`submitTaskWhenReady(...)`** — UNREFERENCED since #227 (deleted with the agent-PTY
  launcher by #233). Was the PTY fallback's task typing over the SessionStart sentinel.
- **`wakeAgentWithPrompt(id, prompt)`** — the live-or-wake delivery used by peer
  messages and the prompt-queue flusher. Order: live SDK session (`sdkDeliver`)
  → live PTY (typed) happens in the callers → **structured wake**
  (`sdkStartAndDeliver`: lazy SDK session resuming `ws.sdkSessionId`, or — for a
  terminal-only workspace — the newest on-disk transcript, adopted as the resume
  id by agent-sdk's `sdkWake`, the same session `--continue` picks). **If the SDK
  session cannot start it returns `false` (#227) — there is no raw-PTY wake any
  more**; every caller's existing fallback applies: `dispatchMessageRequest` → inbox,
  the prompt queue → `requeue()`, the usage-limit nudge → re-mark, and
  `git:fixChecks` / `git:sendReview` (`api-handlers.ts`) → throw `AGENT_WAKE_FAILED`
  instead of typing into a PTY that does not exist and answering "requested".
  Post-wake "did it survive"
  insurance checks (`dispatchMessageRequest`'s inbox park, prompt-queue's
  re-queue) treat a live SDK session as "still up" (`sdkSessionLive`), since
  `isRunning` is PTY-only and always false for a structured wake.
- **The owed brief rides the FIRST send of ANY session start** (`agent-sdk.ts sdkSend`, the one
  chokepoint composer, wake, peer message, bus wake and `recoverPendingPrompts` all pass): a session
  created while the workspace owes its task snapshots `session.owedBrief` BEFORE `consume` can run;
  the first send claims it (`claimOwedOpeningTask`) and queues the brief ahead of the caller's text
  (when the caller's text IS the brief — spawn / Restart — that send is the delivery). It is marked
  DELIVERED (`openingTaskDelivered` + `hasInput`) only when the CLI produces its first NON-ERROR output
  for it (`confirmOpeningTask`, D7) — never at enqueue, never at init; a session that dies or errors
  its first turn unwinds the claim (`unwindOpeningTask`/`failFirstTurn`). So a wake
  or a typed message can no longer retire a brief nothing delivered. `wakeAgentWithPrompt` does not
  flip `hasInput` itself while a brief is owed.
- **Restart of a kept child** — `dispatchRestartRequest` (`restart-workspace.ts`) checks
  `owesOpeningTask(ws)` (and no live PTY/SDK session) BEFORE the classifier: nothing ever
  ran, so `classifyRestartMode` would answer `unknown` ("Open it first"). It calls
  `startWorkspaceAgentHeadless` instead — still failing → `{ok:false,'restart failed: …'}` and a
  fresh error row; cause removed → the task is delivered as the opening turn and `hasInput`
  flips, so the next Restart is an ordinary one; the reply carries `openingTask:true` and the CLI
  prints "Started <id> — its opening task was delivered" (not "conversation preserved"). The kept
  child survives an app restart (`lastTask`/`hasInput`/`sdkStartErrors` are in `store.json`).
  Rigs: `restart_delivers_task_once`, `brief_survives_other_start`, `spawn_init_wait`, `first_turn_error_reported`.

### Admission — automatic starts held under low memory (#286, wave G ledger #295; epic #284)
While the memory guard holds Admission (`isAdmissionHolding(sampleMemoryGuardNow())`, `docs/codebase-map/resources.md` § Memory guard) an
**AUTOMATIC start of a FLEET MEMBER** (a workspace with a `parentId`) is HELD, not run and not failed. Two start entry points carry the gate — the
same sites that already carry the Pause gate and the `origin`: **spawn** (`startWorkspaceAgentOnce`, workspaces.ts, after the "nothing owed" check and
before `sdkStartAndDeliverResult`; also the owed-retry route) and **restart** (`dispatchRestartRequest`, restart-workspace.ts, after the Pause refusal and
BEFORE the classifier / any stop, so a held restart never stops a running session). A held spawn is **accepted**: `SpawnResult.ok:true` + `held:{since}` +
the note `spawn held for memory since <iso> — it starts when memory recovers (Admission)`, the workspace exists, `lastTask` is still owed, NO session starts.
A human act (`origin 'human'`: toolbar Restart, composer, Send now), a top-level / detached workspace and a turn sent to an already-running member are
never held. Pure rules: `src/shared/admission.ts` (`mustHoldStart`, `nextToRelease` coordinators-first then arrival `seq`, `planRelease`); the queue + release
loop: `src/main/admission.ts` (`createAdmission`; process-wide `admissionGate` / `heldStartFor` / `listHeldStarts` / `startAdmission`). **Release**: a pass
takes a FRESH `sampleMemoryGuardNow()` before EACH release and requires `mayReleaseOneStart` (false under a dead meter; the toggle OFF releases at once), runs the
entry's start with `admitted` (so neither the spawn nor the owed-retry gate re-holds it), awaits it (one at a time), pauses `settleMs` (3 s), samples again — a dip
stops the pass and the 10 s retry timer (armed while the queue is non-empty) or the guard's `admission_reopened` edge resumes it. `kick()` is single-flight and its body
starts in a MICROTASK after `draining` is assigned (a pass's own fresh sample can emit the reopen edge synchronously → the subscriber's `kick()` must see the pass, not start
a 2nd one: two releases off one reading); a kick landing while a pass winds down re-runs it. A newcomer arriving while the line is non-empty JOINS it (never jumps).
A release the **fleet Pause refused** (`retryLater`) keeps its slot but is DEFERRED for the rest of the pass — it never blocks the entries behind it (any run) nor newcomers
(a long manual / usage-limit / memory Pause on one run used to freeze every other run); the next retry tries it again. A release that **fails** or **times out** (90 s bound) is
REPORTED to the member's coordinator (`reportAdmissionFailure`, workspaces.ts: a bus `escalation` from the member behind the `liveness` switch, with `orchestra restart <id>`
as the way out) — never a log line only. A queued entry whose workspace is gone / archived / already started by a human is dropped at release **and at READ time**
(`pruneUnowed` in `heldFor`/`list`/`gate`: `peers` / `bus-status` never keep saying "held" for a running member; a restart held for a member that was STOPPED at hold time
is superseded once a person starts it — `liveAtHold`); `teardownWorkspace` (single + bulk delete) drops the held start (`dropHeldStart`). The liveness roster treats a member
with a held start as silenced (`index.ts`, the Pause's predicate slot) — it was told "accepted, held", so the 10-min escalation would be a false stall. Every hold /
release / wait / drop is logged WITH MemAvailable (`[admission] HELD spawn of … — MemAvailable 4.00 GB, Admission held; 2 held start(s)`). **Visible**:
`PeerInfo.heldForMemory`, `orchestra peers` (`idle · spawn HELD for memory since 13:20:11Z`), `/busStatus` `heldStarts` → the CLI's `held starts: N held for
memory, release order — …` line (absent when none), the spawn / restart replies. The queue is IN MEMORY: after an app restart a held child stays stopped with
its brief owed and `orchestra restart <id>` retries it. Gates: `src/shared/admission.test.ts`, `src/main/admission.test.ts`,
`src/main/admission-wiring.test.ts` (source guards + a tripwire on who imports the gate), `scripts/e2e-admission-hold.mjs` (real workspaces/restart/admission/guard,
fake memory source + recording seam; `RIG_REPO=<master>` is the must-FAIL run), `scripts/admission-mutants.mjs` (in-place mutants, `--check-anchors`),
`src/main/admission-liveness.test.ts` (real roster + sweep + queue).

#### Wakes (#287, wave G ledger #295) — every automatic START of a SLEEPING fleet member waits too
Held kind `'wake'` (`HeldStartKind`, rank 1 < spawn/restart rank 2: a held spawn/restart COVERS a wake of the same member — the wake is answered "held" and what it was for
reaches the running member as a plain turn on the next sweep, ≤ 60 s). **Sleeping** = no PTY and no live SDK session (`isSleeping`, `src/main/admission-wake.ts`); a turn to a
running member, a top-level workspace and a human act are never held. A wake site calls `wakeHeldForMemory(ws, retry, {stillOwed?})` BEFORE it starts anything: `true` = skip it and
leave the durable pending state EXACTLY as it is; the queue (coordinators first, one at a time, fresh `sampleMemoryGuardNow()` + `mayReleaseOneStart` before each release, same
settle / retry / 90 s bound) then grants a **one-shot permit** (`holdWake`, admission.ts: `permits` Set) and runs the site's own `retry`, whose `holdWake` consumes it and goes
through; the permit is revoked when the run ends (never a stale bypass of a LATER hold). Sites: **bus réveil** (`sweepBusWake`, bus-wake.ts: after `decideWake`'s skip handling,
BEFORE the ledger mark and every counter — no `fired`/`failed`/`counted` change, no re-fire per sweep; skip reason `held-for-memory`, logged ONCE per transition at info;
release = `sweepBusWakeNow()`, a sweep that is guaranteed to run; the reader keeps its pending lot → delivered after release, `orchestra check` returns it intact, `ack` clears it;
the roster carries `fleetMember`/`sleeping`/`coordinator`, wake-roster.ts) · **parked-prompt flush** (`flushQueuedPrompts`, prompt-queue.ts: timer flush only — "Send now"/`force` passes —
held BEFORE the queue is cleared) · **usage-limit auto-resume** (`resumeUsageLimited`: held before the budget, the marker clear and the re-mark) · **peer message to a stopped member**
(`dispatchMessageRequest`: parked in the inbox, honest `delivery:'inbox'`, the queue wakes the member with a content-free prompt and re-releases the block after a drain grace) ·
**view-open recovery** (`agentSdkHistory`, api-handlers.ts: pending prompts resent to a sleeping member). A held-SPAWN child is no longer started by a bus message (it used to bypass
the hold). NOT gated: watchdog `recycleSession`, account-migrate resume, Reprise starts (replace a running session / human or Pause lift), `--detached` spawns. Gates:
`scripts/e2e-admission-wake.mjs` (12 arms, `RIG_REPO=<master>` = must-FAIL; real bus + sweep + roster + prompt queue + message dispatch, fake memory source + recording seam),
`admission.test.ts` W1–W9, `admission-wiring.test.ts` `#287 …` pins (the recovery site is wiring-pinned only), `admission-mutants.mjs` W-series (`rig: 'wake'`).

### Archive / unarchive / delete
- **`archiveWorkspace`** `:534` (soft: stop PTYs, keep worktree+logs),
  **`unarchiveWorkspace`** `:559`, **`deleteWorkspace`** `:450` (hard: runs the
  per-repo archive script best-effort, clears scrollback+inbox, `removeWorktree`,
  removes record, broadcasts `workspace:removed`). Directory removal is
  hard-confined to `ORCHESTRA_ROOT`/`SCRATCH_ROOT`. **Sandbox-hosted** records
  (`:491`) just detach — the container keeps its copy; nothing local to reap.
  The reap steps are factored into **`teardownWorkspace(ws)`** (everything
  except the store-remove + broadcast) so both `deleteWorkspace` and the bulk
  path share them. Its first act `forgetHibernationActivity(id)` also marks the
  id `isBeingDeleted` so the hibernation sweep skips it (delete/hibernate
  serialization, #205); then **#201:** `stopStructuredSession(id)` —
  awaited `sdkStopIfLive` (drops the in-memory session) + `killKeeper(id,
  'workspace-deleted')` (kills a surviving keeper/CLI, sweeps its pid/sock) —
  also run by `pruneOrphanedWorkspaces` (boot). It sits in the workspaces.ts
  chokepoint, not api-handlers' fire-and-forget `sdkStopMany` (which skips a
  session-less survivor and is bypassed by the CLI socket route
  `dispatchDeleteWorkspaceRequest`). `deleteWorkspaces` tombstones (`forbidKeeperLaunch`) EVERY id before the first teardown (L5); the boot
  `pruneOrphanedWorkspaces` runs the stops in the BACKGROUND (`pendingStops`, not awaited — it precedes first
  paint; 4 orphans 12 s → 75 ms). No session/keeper (hibernated, never
  started) → instant no-op. Gate: `del_*` arms of `scripts/e2e-keeper-lifecycle.mjs`.
- **Cascade:** archive/unarchive an orchestrator and its whole subtree moves
  with it. **`collectWorkspaceTree(id)`** `:517` gathers the root plus every
  transitively `parentId`-nested descendant (BFS, cycle-guarded); both
  `archiveWorkspace`/`unarchiveWorkspace` iterate it, skipping records already in
  the target state, and broadcast a `workspace:update` per changed child so the
  renderer's tree updates live. A child archived on its own stays independent
  until its parent is unarchived.
- **`deleteWorkspaces(ids, window, onProgress?)`** — bulk hard-delete. Reaps
  every worktree sequentially (gentle disk I/O; archive scripts + `git worktree
  remove` per id), then **one** `store.removeWorkspaces(ids)` write + **one**
  `workspaces:removed` broadcast — versus the old renderer loop that paid a full
  serialized `store.json` rewrite and two re-renders *per* workspace, the source
  of the app-wide jam when clearing dozens of archived workspaces. Progress ticks
  stream via `workspaces:deleteProgress`. Wired from the archived-section bulk
  delete (`Sidebar.tsx` `onDeleteSelectedArchived`) through IPC
  `workspaces:deleteMany`; the renderer prunes all ids in a single `set()` in the
  `onWorkspacesRemoved` handler.
- **`pruneOrphanedWorkspaces(window)`** `:544` — startup reconcile: `git worktree
  list` per repo (parallel); a workspace whose path git no longer tracks is
  removed. Skips repos it can't verify (missing/unmounted) so it never nukes
  unverifiable records, and **skips sandbox-hosted records** (`:572` — their
  worktree was retired to trash at import by design).
- **Import / eject / backups** — a workspace moves INTO a container via
  `importWorkspaceToSandbox` (`sandbox-import.ts:188`; local worktree retired
  to `~/.orchestra/trash/`) and back via `ejectWorkspaceFromSandbox` (`:397`),
  with automatic snapshots in `~/.orchestra/backups/<id>/`. Full flow in
  [sandbox-transport.md](sandbox-transport.md).

### Resume across restarts (lazy, on first open)
- There is **no startup auto-resume** (an earlier `resumeRunningWorkspaces`
  relaunched every previously-running agent at boot — removed: a restart with
  many live workspaces immediately spawned that many `claude --continue`
  processes). `store.load()` resets persisted `running` → `idle`; the agent
  relaunches with `--continue` (via `pty:start` → `startAgentPty`) the first
  time the user opens the workspace — TerminalView only spawns once its tab is
  visible (fit-dimensions gate, `Terminal.tsx`). During the cold boot the pane
  shows a "Resuming previous session…" pill (see the cold-boot pill in
  [activity-pty-terminal.md](activity-pty-terminal.md)) — Claude paints only
  its splash header while the session reloads, so the pane would otherwise
  look blank for a couple of seconds.

## Worktree mechanics (git.ts)
- `createWorktree(repoPath, branch, baseBranch, worktreePath)` — `git worktree
  add -b`. Path is `~/.orchestra/worktrees/<repo>-<safeBranch>-<idShort>`.
- `removeWorktree`, `listWorktreePaths` (porcelain parse). See
  [git.md](git.md) for the full git surface.

## Spawn & orchestration (socket dispatch handlers)
All return `{ ok, ... }` envelopes; routed from `hooks-server.ts`. See
[hooks-cli-socket.md](hooks-cli-socket.md) for the HTTP routes.

| Handler | Line | Route | Purpose |
|---|---|---|---|
| `dispatchSpawnRequest` | `:932` | `/spawn` | Create child workspace + start it as a **structured SDK session** (`startWorkspaceAgentHeadless`). **A start that fails is reported, not masked (#227):** `ok:false` + `error` naming the reason and the kept child (`id`/`branch` also on the reply); the child stays stopped with its task, Restart retries. No PTY fallback. Inherits caller's repo (worktree callers) or requires explicit `repoPath` (scratch/orchestrator callers). Records `parentId` = caller, unless `detached:true` (parentless top-level workspace; repo inheritance from `from` still applies). Optional `model` pins the agent's model on the record (`Workspace.model`, `types.ts`) — the pty passes `claude --model` on every launch, and the SDK structured-session path must mirror it via `options.model`. **Omitted → the user's *spawned-agent default model*** (`defaultKind: 'spawned'` from `/spawn` and sandbox spawn; the UI's spawn-from-ticket click passes `'workspace'`). `createWorkspace` freezes `modelForNewWorkspace(...)` onto every new record (`src/shared/model-defaults.ts`; settings in `store.getModelDefaults()`, edited from the sidebar's Default models modal `ModelDefaultsSettings.tsx`); launch paths resolve via `resolveLaunchModel` (`default` marker = account default, no `--model`). The reasoning effort mirrors it: `createWorkspace` freezes an explicit `/spawn` `effort` (`orchestra spawn --effort`), else `effortForNewWorkspace(store.getEffortDefaults(), defaultKind)`, onto `ws.sdkEffort` (`src/shared/effort-defaults.ts`; same modal; `default` = leave unset), and the PTY launch passes `--effort` when set (the SDK path already reads `ws.sdkEffort`). The model guard is a charset/length check only — a dead model id passes it and fails at the child's own launch — a CLI that exits, or errors its first turn, before producing output now makes spawn not-ok (#227 D7); one that only retries (`api_retry`, process alive) is ok + a "not confirmed" note. |
| `dispatchPromoteRequest` | `:2010` | `/promote` | Make a workspace a coordinator (idempotent). **Two routes**: a scratch session swaps `kind` → `'orchestrator'`; a **git worktree keeps its kind and gains `canOrchestrate`**, so it parents children while keeping repo/branch/diff/merge/PR. **#171: promote is a re-anchoring op** — the promoted node stops resolving to its parent OPS/LEAD and becomes its OWN run, so it now `snapshotRunAnchors(id)` **before** the mutation and `reconcileRunAfterReparent(…, {noRestart:false, preferStaleForLivePty:true})` **after** (both routes), exactly like attach/demote. An idle live session is restarted so its rebuilt env re-reads `ORCHESTRA_RUN_ID` + generation (removing the manual `orchestra restart` the ticket hit 4×); a working structured session's restart is refused (mid-turn guard → `{ok:false}` → mark-stale) and a raw PTY is deferred (`preferStaleForLivePty` — the PTY restart has no working guard). Returns `restarted`/`markedStale` like the re-parent handlers. **#221:** promoting a child of a run-less PLAIN workspace also starts that workspace's MISSION run (coordinator = itself) and nests the child's run under it — the parent stays a plain workspace (see `bus.md` §#221). |
| `dispatchDemoteRequest` | `:1384` | `/demote` | Inverse of promote. Clears `canOrchestrate` and **detaches every child** (a `parentId` pointing at a non-orchestrator renders nowhere). Refuses the `'orchestrator'` KIND — it is repo-less by nature and has no worktree to fall back to. |
| `dispatchAttachRequest` | `:1456` | `/attach` | Re-parent under a coordinator (`canOrchestrate`), or clear `parentId` to detach. **Full-ancestry cycle check**: a promoted worktree can itself have a parent, so A→B→A is reachable and the old bare self-check was no longer sufficient. |
| `dispatchSetRepoAssociationRequest` | `:1834` | `/setRepoAssociation` | File an `'orchestrator'`-KIND session under a repo's sidebar section (with its subtree), or clear it. Writes **`repoAssociation`, never `repoPath`** — see below. Refuses a git worktree (it already groups by its own repo) and any path not in `store.repos`. |
| `dispatchVerifyLandedRequest` | `~:1590` | `/verifyLanded` | **Coordinator close-out check** (read-only): are ALL commits on a child's branch **tip** reachable from the target? Target = explicit `into` ref (repo-less coordinators) or the caller's own branch (`from`, must share the child's repo — the integration-branch case). Backed by `listUnmergedCommits` (git.ts, ref-validates first so a deleted branch fails loudly instead of reading "0 unmerged"; tests in `git-verify-landed.test.ts`). Exists because a child's "done"/"merged" report decays — agents keep committing after they report. NOT LANDED is not always a defect: deliberately-unmerged work (spikes) closes as INTENTIONALLY UNMERGED — the contracts forbid only the *silent* strand. **Exit codes** (`orchestra verify-landed`): `0` LANDED · `2` NOT LANDED · `1` could-not-check, so a close-out gate can distinguish unmerged work from a failed check — never gate on `$?` being nonzero alone. See `hooks-cli-socket.md`. |
| `dispatchWhoamiRequest` | `~:1660` | `/whoami` | A workspace's own record (id/name/branch/kind, `orchestrator` via the `canOrchestrate` helper, `parentId`, repo/base). The only in-band way an agent learns its `parentId` — `/peers` excludes the caller, and a child promoted BY its parent never observes the promotion — which is what makes "at most one sub-orchestrator level" checkable by its addressee. |
| `dispatchPeersRequest` | `:1239` | `/peers` | List other live workspaces (`PeerInfo[]`). `stats: true` adds each git peer's committed three-dot diff vs base (`getBranchDiffShortstat`, git.ts) — opt-in because the comms-resurface hook hits `/peers` every prompt and N git spawns on that path is the per-workspace × per-poll trap. |
| `dispatchReadRequest` | `:1266` | `/read` | Peer branch + last ~80 transcript lines, ANSI-stripped. |
| `dispatchMessageRequest` | `:1353` | `/message` | Deliver to peer: **live** (next turn of a live SDK session, else typed into a running TUI), **started** (structured wake via `wakeAgentWithPrompt`; no PTY fallback — #227), or **inbox** (also what an unstartable wake lands in) (park in `~/.orchestra/inbox/<id>.txt`; the 5s post-wake insurance counts a live SDK session as delivered). |
| `dispatchRenameRequest` | `:722` | `/rename` | see Branch management. |
| `dispatchAddRepoRequest` | `:1024` | `/addRepo` | Register repo. |
| `dispatchDeleteWorkspaceRequest` | `:1054` | `/deleteWorkspace` | Hard-delete. |

## Re-parenting re-derives the bus run (#142)

A workspace's bus run id is its **nearest orchestrator** (`resolveWaveRunId` →
`nearestOrchestratorId`, #134 D1), derived at `createWorkspace` and baked into the
member's env (`ORCHESTRA_RUN_ID`) + its `.orchestra/bus-switches` notice. So
`attach`/`detach`/`adopt`/`demote` change the **tree** but a RUNNING session keeps
sending into the OLD run and reads the OLD frozen flags until it restarts — the gap
#142 closes (ledger #135 review-F2 R2, carved by ruling D3; D1a-bis: a message is
governed by the flags of the **innermost** run of its two parties).

- **The pure decision** — `src/shared/reparent-run.ts` `decideReparentAction`:
  anchor UNCHANGED → `noop`; anchor changed + no live session → `notice-only`
  (the next launch re-reads the env); + live + restart allowed → `restart`;
  + live + `--no-restart` → `mark-stale`. Unit-tested (`reparent-run.test.ts`).
- **The effectful reconcile** — `reconcileRunAfterReparent(oldAnchors, {noRestart})`
  (`workspaces.ts`, near the admin handlers). Each handler `snapshotRunAnchors(root)`
  (the subtree's run ids) BEFORE mutating the store, then reconciles AFTER: it
  re-derives each anchor, rewrites the notice for the new run
  (`writeBusSwitchState`), lazily starts the new run row (`maybeStartRunAtAnchor`),
  and then restarts conversation-preserving (#111 `dispatchRestartRequest`,
  `fresh:false`, via a dynamic import that breaks the workspaces↔restart-workspace
  cycle) OR — with `--no-restart` — marks stale (`markWorkspaceStaleRun`: the
  `.orchestra/bus-run-stale` marker + the `busRunStale` store flag). Best-effort per
  workspace (D1). Wired into `dispatchAttachRequest` (both branches),
  `dispatchDemoteRequest` (the detached children), `dispatchAdoptRepoRequest` (the
  moved worktree path), and **`dispatchPromoteRequest` (#171, both routes)**.
- **#171 — restart refused/failed ⇒ mark-stale (not a silent warn).** When the
  reconcile's restart returns `{ok:false}` (a working structured session throws the
  mid-turn guard, or any relaunch failure) it now DOWNGRADES to `markWorkspaceStaleRun`
  instead of only logging — so the live session is never left on the OLD run without
  an operator signal (the #171 promote symptom), and never killed mid-turn (arm 2:
  "refused-or-deferred explicitly"). `preferStaleForLivePty` (promote only) additionally
  forces a LIVE raw PTY down the mark-stale branch up front, because `restartPty` has
  no working guard and a PTY exposes no turn state to prove it idle. `markWorkspaceStaleRun`
  is the shared marker+flag writer both the explicit `--no-restart` branch and this
  fallback call. Rig: `scripts/verify-promote-run-refresh.mjs` (`pnpm test:promote-refresh`)
  drives the SHIPPED `dispatchPromoteRequest` over a real bus and mutation-proves the
  unfixed promote (no reconcile) leaves the notice on the parent run.
- **`--no-restart`** — CLI flag on `attach`/`detach`/`adopt-repo` (forwarded through
  `/attach`, `/adoptRepo`). Marks the workspace 'stale run'; the store-less CLI
  `send` REFUSES from it (`refuseIfStaleRun`, keyed on the `.orchestra/bus-run-stale`
  marker — a NEW pre-send gate, NOT the #144 recipient predicate) until a restart.
  `dispatchRestartRequest` calls `clearBusRunStale` (marker + flag) on every restart,
  so the block self-heals. The bus PANE lists stale workspaces via `BusStaleRunView`
  (`listStaleRunWorkspaces` seam → `busSnapshot.staleRunWorkspaces` → `BusStaleRunList`).
- **Acceptance** — `reparent-run.test.ts` (pure decision, mutant arms),
  `reparent-run-binding.test.ts` (the handlers/CLI actually WIRE the reconcile),
  `scripts/verify-reparent-run-notice.mjs` (G5: the notice names the NEW run's
  frozen flags over a REAL bus + the shipped `writeBusSwitchState`, with a
  same-command must-FAIL control). The packaged send/wake drive is VERIFY-G's.

## Branch management
- `randomBranchName` ~`:249` (1024 adjective-noun combos).
- **`renameWorkspaceBranch(id, newBranch, {manual, bumpAutoCount}, window)`**
  `:664` — scratch: relabel only; worktree: `git branch -m` (via git.ts
  `renameWorktreeBranch`). `manual` (human UI edit / out-of-band) pins
  `branchManuallySet`; `bumpAutoCount` (agent auto-rename) instead increments
  `autoRenameCount`. `freeBranchName` dedupes collisions with `-2..-99`.
- **Progressive auto-rename** — the agent gets **two** staged auto-renames
  (`MAX_AUTO_RENAMES`, `:730`): an early provisional name, then a refined name
  once the work is well-defined. `autoRenameActive(ws)` (`:738`) — `!branch­ManuallySet && autoRenameCount < 2` — is the single gate for the
  `ORCHESTRA_BRANCH_AUTO` env flag and for whether `dispatchRenameRequest`
  (`:754`) counts a rename. After the budget is spent the nudge retires, but the
  agent can still rename on demand (no more hard "already set" refusal).
- **`branchManuallySet`** = human-pinned (UI edit, out-of-band `git branch -m`
  adopted by activity.ts, `switchWorkspaceBranch`); hard-stops the nudge for
  good. **`autoRenameCount`** tracks the agent's own progressive renames.
  `.orchestra/.branch-renamed` sentinel holds the live count so the hook advances
  stage / self-disables mid-session before a pty restart refreshes the env.
- **`switchWorkspaceBranch(id, branch, window)`** `:1454` — `git switch`, stop
  agent+nvim PTYs, clear scrollback, set `hasInput:false` + `branchManuallySet`,
  emit `pty:restart`.

## Hooks installed per worktree
`installOrchestraHooks(worktreePath)` — `workspaces.ts:2156`. Idempotent via a
`HOOKS_VERSION` stamp hashing every script body + command. Writes the shell
scripts to `<worktree>/.orchestra/` (temp file + `rename()`, so a running hook
keeps its inode) and 6 capability skills to
`<worktree>/.claude/skills/`, then merges hook commands into
`settings.local.json` and evicts deprecated ones. Full detail (events, scripts,
env-guarding) in [hooks-cli-socket.md](hooks-cli-socket.md).

## Persistence — store.ts (273 lines)
- Shape: `{ repos: RepoEntry[], workspaces: Workspace[], accounts?: Account[] }`
  at `~/.orchestra/store.json` (or `$ORCHESTRA_HOME/store.json`).
- **Atomic writes** via a serialized promise chain (`writeChain`) + temp-file
  rename (~`:89`). Load migrates stale `running`/`stalled` → `idle` (agents
  relaunch lazily on first open, not at startup).
- **Removal tombstone (#205):** `removeWorkspace`/`removeWorkspaces` add the id to
  an in-memory `removedIds` set; `upsertWorkspace` DROPS (warn-logged) an upsert
  of an id that is absent AND tombstoned — so no stale `getWorkspace` → `await` →
  `upsertWorkspace({...ws})` (~65 callers, e.g. `clearBusRunStale`,
  `wakeAgentWithPrompt`, `human-gates syncWorkspaceGateCounts`, whose loop
  iterates an OLD array snapshot) can resurrect a deleted workspace. An id
  present in the store still updates; a never-removed id (spawn/create — fresh
  UUIDs) still inserts. `persistWorkspacePatch` is NOT a racer (get→upsert with no
  await between). Rig: `scripts/e2e-delete-resurrect.mjs` (13 arms), gate
  `src/main/store-delete-resurrect.test.ts`.
- Methods: `upsertWorkspace`, `removeWorkspace`, `getWorkspace`,
  `reorderWorkspaces`; repo methods `addRepo`/`removeRepo`/
  `updateRepo`/`getRepoScripts`/`setRepoScripts`; `allocatePort` (~`:185`, range
  55100–55600, counts non-archived only); account methods with validation.

## Setup/run/archive scripts — scripts.ts (127 lines)
- `buildScriptEnv(ws)` injects `ORCHESTRA_WORKSPACE_PATH`, `ORCHESTRA_ROOT_PATH`,
  `ORCHESTRA_BRANCH`, `ORCHESTRA_PORT`.
- `runOneShot({script, cwd, env, logFile})` spawns `$SHELL -ilc '<script>'`
  (interactive login shell, so nvm/version-managers load), pipes to log, returns
  `{exitCode, lastStderrLine}`. `RepoScripts` = `{setup?, run?, archive?}`
  (`types.ts:173`). Run scripts get their own `<wsId>:run` PTY.

## Secrets — secrets.ts (107 lines)
Electron `safeStorage` (libsecret/Keychain/DPAPI) at `~/.orchestra/secrets.json`;
falls back to 0600 plaintext with a warning if no keyring. Currently stores the
Linear API key: `getLinearApiKey`/`setLinearApiKey`/`clearLinearApiKey`.

## Base-branch sync — repo-sync.ts (113 lines)
`syncAllRepos(window)` (parallel per repo) → `syncBaseBranch` (git.ts) +
`getBaseSyncState` (behind/ahead vs `origin/<base>`), broadcast as
`repo:syncState`. Fires on focus, startup, and the refresh button.

The tracked base is `RepoEntry.defaultBranch` — auto-detected at add
(`detectDefaultBranch`, git.ts) and user-configurable from the repo settings
modal via IPC `repos:setDefaultBranch` (index.ts; validates the branch exists,
rebroadcasts `repos:update`, kicks `syncOneRepo`). New workspaces are cut from
it unless `CreateWorkspaceInput.baseBranch` overrides per workspace
(right-click the repo's sidebar "+", or `orchestra spawn --base`).

## Worktree sizes — workspaces.ts `getWorktreeSizes`
Read ONLY by the Resources page (the sidebar's per-row size badge was removed);
`App.tsx` therefore polls this only while `page === 'resources'`, so a closed
Resources page costs zero scans. One scan over `ORCHESTRA_ROOT`
(`src/main/workspaces.ts:~230`), returning `WorktreeSizes { sizes, exclusive }`
(`src/shared/worktree-sizes.ts`, which also holds the pure output parsers +
tests). Two scanners: `btrfs filesystem du -s --raw` reporting **exclusive
(reclaimable) bytes** — pnpm reflink-clones packages on btrfs, so a ~580 MB-
looking worktree is often ~2 MB exclusive — with a plain `du -k` apparent-size
fallback (non-btrfs/macOS; `exclusive: false` switches the renderer tooltip).
The btrfs pass gets no page-cache discount (~7 s of extent ioctls every time),
so results are TTL-cached 120 s in main, keyed on the worktree-path set so
add/delete invalidates; the renderer polls every 30 s while the Resources page
is open (`App.tsx`) and mostly hits that cache. Scratch dirs live outside `ORCHESTRA_ROOT` and are never scanned.

## Key invariants
One worktree per workspace · `accountId` pinned for life · `parentId` only
persisted if parent exists (dangling → child floats to repo section) · setup is
async/non-blocking · hooks idempotent (version stamp) · store writes atomic ·
scrollback ring-buffered at 2 MB · all cleanup best-effort.
