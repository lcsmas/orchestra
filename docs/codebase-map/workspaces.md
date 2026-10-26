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
  without a session restart; `unmarkOrchestratorWorktree` removes it on `/demote`).
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
- **The agent's SDK session is stopped — and awaited — first (#378).**
  `stopAgentSessionForMove` (`workspaces.ts`): snapshot the keeper tree → `sdkStopIfLive` → `killKeeper`
  (awaits the CLI's death) → `killKeeperTree` (its background jobs) → fail closed (a live session or tracked
  keeper afterwards throws, nothing moves). It forbids no launch (the next send restarts lazily) and is
  NOT a `stopMemberScopeIfAny` site (`scope-stop-wiring` pins exactly 3). Sandbox import / eject
  (`sandbox-import.ts`) use the same helper before staging / fetching. A self-adopt cuts the caller's own CLI;
  the move completes. Gate: `scripts/e2e-stop-before-move.mjs` (must-FAIL on master d55d6737).

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
`renameWorkspaceBranch` (`:979`) stops running `git branch -m` (label desyncs
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
lock; written only via `naming-policy.ts`), `divergedFromBase`/`mergedAt`/`unpushedAhead`/`releasedVersions`
(sidebar pills), `contextTokens` (badge seed), `markedUnread`
(manual come-back-later bookmark, toggled from the sidebar via
`workspaces:setUnread`, auto-cleared on next selection), and **`host`**
(`WorkspaceHost`, `types.ts:69` — absent = local; `{kind:'sandbox',
endpoint}` = agent lives in an always-on container, see
[sandbox-transport.md](sandbox-transport.md)).

## Lifecycle

### Create
- **`createWorkspace(input, defaultKind, naming?)`** — `workspaces.ts:316`. Steps: ensure root →
  generate UUID → **pick the branch NAME under a per-repo lock** (`branchAllocation` = `shared/keyed-lock.ts`, keyed on the
  repo's REAL path so a symlinked registration is the same repo; #382 follow-up): `freeBranchName` →
  `shared/branch-slots.ts` `freeBranchSlot` (the requested name, suffixed `-2…-99`, else `randomBranchName()` adjective-noun) sees the
  names of creations still in flight (`reservedBranches`) as taken, and the pick is RESERVED before the lock is released —
  so parallel same-name spawns get distinct names; the lock covers only that pick, **never the checkout**: `createWorktree`
  (git.ts) runs outside it (a fan-out stays parallel, a hung checkout blocks only itself) and releases the reservation
  in a `finally` (the pick takes a SNAPSHOT of the reservations BEFORE its branch listing awaits — a creation finishing during the listing cannot make its name vanish from both). Known limit: the rename and adopt-repo paths also call `freeBranchName` but do not consult `reservedBranches` (a millisecond window; #383's seam). `naming.exactName` (agent route only) also treats a branch folder (`impl-z` vs an existing `impl-z/sub`)
  as taken and REFUSES when the name and every suffix are taken, instead of the random fallback → `installOrchestraHooks` → `store.allocatePort()` → build record,
  **pin repo's `accountId`** (~`:297`), record `parentId` only if parent exists
  (~`:302`) → persist + broadcast `workspace:update` → fire setup script async
  (does NOT block) → starts no agent (the SDK session starts lazily: first send, wake or spawn).
  An old store record still carrying the removed heavy-resume flag loads untouched (#233: no migration, nothing reads or writes it).
- **`createScratchWorkspace`** / **`createOrchestratorWorkspace`** —
  `workspaces.ts:403` / `:407` (both wrap `createScratchLikeWorkspace`, `:361`).

### Agent TMPDIR on disk (`src/main/agent-tmpdir.ts`, pure `src/shared/agent-tmpdir.ts`)
Every LOCAL agent session (`buildSdkEnv` in `agent-sdk.ts`; the Run / nvim / login terminals of `pty.ts` do not) gets
`TMPDIR=/var/tmp/orch-<uid>-<6 hex of ORCHESTRA_HOME>/<12 hex of ws id>` + the marker `ORCHESTRA_AGENT_TMPDIR`
(read by `tmp-guard.sh`, hooks-cli-socket.md). Why: `/tmp` is a tmpfs (RAM); the real CLI passes TMPDIR to Bash,
and `os.tmpdir()`/`mktemp`/its own `claude-<uid>` dir follow it (measured, claude 2.1.291). Path ≤ 60 bytes
(`AGENT_TMPDIR_MAX_LEN`: headless Chromium core-dumps at 65 — its SingletonSocket must fit AF_UNIX). Root created
0700 and refused unless ours (world-writable `/var/tmp`). Removed in `teardownWorkspace` / prune (empty root too);
boot `sweepAgentTmpDirs` (`index.ts`, after prune) drops dirs of unknown ws (an empty store sweeps nothing).
`ORCHESTRA_AGENT_TMP_BASE` = another base (rigs) or `off`; OFF under `node --test` unless a base is given, and the
rigs that strip `ORCHESTRA_*` set `off` (else one root per scratch home). Linux only.

### Setup (repo workspaces only)
- **`runSetupScript(id, window)`** — `workspaces.ts:583`. Sets `setupStatus`
  `pending→running→ok|failed`, runs via `runOneShot` (scripts.ts), captures last
  stderr line into `setupError`. Log: `~/.orchestra/scripts/<id>-setup.log`.
  Failure never blocks creation; UI offers retry.

### Start agent
- **There is no agent-PTY launcher (#233).** The launcher (heavy-resume gate and its persisted flag, the
  `claude --continue` guard, the SessionStart ready-file sentinel, task typing + submit retries, the sandbox
  `CLAUDE_CONFIG_DIR` strip) and its IPC channels (start, repaint, stopped, agent stop, clipboard image save)
  were deleted; the Run script, nvim and account login are the only PTYs
  (`pty.ts`), and every agent is an SDK session (`agent-sdk.ts` `ensureSessionInner`: hook install, account-config
  sync, `buildSdkEnv`, `query()`).
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
- **`wakeAgentWithPrompt(id, prompt)`** — the live-or-wake delivery used by peer
  messages, the prompt-queue flusher, fix-checks and send-review. Order: live SDK session (`sdkDeliver`)
  → **structured wake**
  (`sdkStartAndDeliver`: lazy SDK session resuming `ws.sdkSessionId`, or — for a
  terminal-only workspace — the newest on-disk transcript, adopted as the resume
  id by agent-sdk's `sdkWake`, the same session `--continue` picks). **If the SDK
  session cannot start it returns `false` (#227) — there is no raw-PTY wake any
  more**; every caller's existing fallback applies: `dispatchMessageRequest` → inbox,
  the prompt queue → `requeue()`, the usage-limit nudge → re-mark, and
  `git:fixChecks` / `git:sendReview` (`api-handlers.ts`) → throw `AGENT_WAKE_FAILED`
  instead of answering "requested" (#232: the old "type it into a live PTY" branch of
  those two handlers, of `dispatchMessageRequest` and of the prompt-queue flush is gone —
  none of them reads `isRunning` of an agent any more; a refused/unstartable wake is the
  only "false"). Post-wake "did it survive"
  insurance checks (`dispatchMessageRequest`'s inbox park, prompt-queue's
  re-queue) ask `sdkSessionLive` only.
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
  `owesOpeningTask(ws)` (and no live SDK session) BEFORE the classifier: nothing ever
  ran, so `classifyRestartMode` would answer `unknown` ("Open it first"). It calls
  `startWorkspaceAgentHeadless` instead — still failing → `{ok:false,'restart failed: …'}` and a
  fresh error row; cause removed → the task is delivered as the opening turn and `hasInput`
  flips, so the next Restart is an ordinary one; the reply carries `openingTask:true` and the CLI
  prints "Started <id> — its opening task was delivered" (not "conversation preserved"). The kept
  child survives an app restart (`lastTask`/`hasInput`/`sdkStartErrors` are in `store.json`). `sdkMemNotices` (#322: the Plafond mémoire's kill / warning rows, capped 50, identity (unit, seq)) is persisted the same way and merged into `sdkHistory` by `at`.
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
memory, release order — …` line (absent when none), the spawn / restart replies. **NOT here**: the watchdog recycle, fast Veille (#288 — the Veille sweep side,
`activity-pty-terminal.md` §Session hibernation); wakes are below (#287). The queue is IN MEMORY: after an app restart a held child stays stopped with
its brief owed and `orchestra restart <id>` retries it. Gates: `src/shared/admission.test.ts`, `src/main/admission.test.ts`,
`src/main/admission-wiring.test.ts` (source guards + a tripwire on who imports the gate), `scripts/e2e-admission-hold.mjs` (real workspaces/restart/admission/guard,
fake memory source + recording seam; `RIG_REPO=<master>` is the must-FAIL run), `scripts/admission-mutants.mjs` (in-place mutants, `--check-anchors`),
`src/main/admission-liveness.test.ts` (real roster + sweep + queue).

#### Wakes (#287, wave G ledger #295) — every automatic START of a SLEEPING fleet member waits too
Held kind `'wake'` (`HeldStartKind`, rank 1 < spawn/restart rank 2: a held spawn/restart COVERS a wake of the same member — the wake is answered "held", its site registration is
dropped, and what it was for reaches the running member afterwards through the site's OWN trigger: the next sweep ≤ 60 s / the next bus write, the 20 s prompt-queue tick, the inbox
hook at the start). **Sleeping** = no live SDK session (`isSleeping`, `src/main/admission-wake.ts`; the bus-wake roster's `sleeping` is the same predicate — #232); a turn to a running member, a top-level workspace and a human act are
never held. A wake site calls `wakeHeldForMemory(ws, retry, {site, stillOwed?, reenters?})` BEFORE it starts anything: `true` = skip it and leave the durable pending state EXACTLY as it is.
**One slot per member, one retry per SITE** (`'sweep' | 'flush' | 'resume' | 'message' | 'recovery'`; `wakeSites` in admission.ts): two sites holding the same member never overwrite each
other; the entry stays queued while ANY site is owed (judged once, before the first retry). The queue (coordinators first, one at a time, fresh `sampleMemoryGuardNow()` +
`mayReleaseOneStart` before each release, same settle / retry / 90 s bound) runs EVERY owed site's retry, each under its own **one-shot permit** (`permits` Set; a re-entering retry
consumes it in its own `holdWake`; `reenters:false` sites — peer message, recovery — start the member directly and get none, so no other site can ride it); the permit is revoked when
the retry ends. After the retries the release **waits for the started member's first turn** (`setAdmissionWakeSettle` → `sdkAwaitFirstTurn`, ≤ 20 s inside the 90 s bound) so the next fresh
reading includes its memory — as a spawn / restart release does. A release whose retry throws is logged + reported to the coordinator like any failed release. A WAKE release in flight
covers another wake but NOT a restart/spawn (that one is queued behind it). Sites: **bus réveil** (`sweepBusWake`, bus-wake.ts: after `decideWake`'s skip handling, BEFORE the ledger
mark and every counter — no `fired`/`failed`/`counted` change, no re-fire per sweep; the reader is RE-READ via the per-reader roster seam `setWakeRosterEntry` right before the decision
and `stillOwed` checks that one reader, never the whole roster; skip reason `held-for-memory`, logged ONCE per transition at info; release = `sweepBusWakeNow()`, a sweep that is guaranteed
to run; the reader keeps its pending lot → delivered after release, `orchestra check` returns it intact, `ack` clears it; the roster carries `fleetMember`/`sleeping`/`coordinator`,
wake-roster.ts) · **parked-prompt flush** (`flushQueuedPrompts`, prompt-queue.ts: timer flush only — "Send now"/`force` passes — held BEFORE the queue is cleared) · **usage-limit
auto-resume** (`resumeUsageLimited(now, only?)`: held before the budget, the marker clear and the re-mark; the release re-runs THIS member only) · **peer message to a stopped member**
(`dispatchMessageRequest`: parked in the inbox, honest `delivery:'inbox'`; the queue wakes the member with a content-free prompt and the inbox HOOK drains the block at session start —
nothing re-releases it; a failed park withdraws only the `'message'` site, `dropWakeSite`) · **view-open recovery** (`agentSdkHistory`, api-handlers.ts: pending prompts resent to a
sleeping member). A held-SPAWN child is no longer started by a bus message (it used to bypass the hold). NOT gated: watchdog `recycleSession`, Reprise starts
(replace a running session / human or Pause lift), `--detached` spawns. **Keeper-resident members are never held** (review F1): after an app relaunch a member's CLI can live on in its
detached keeper while the in-memory session is absent (reattach is lazy) — its wake only REATTACHES (no new process). `keeperResident` (admission-wake.ts: `probeKeeper` running AND
`everStarted !== false` AND not `shuttingDown` — the never-started / dying cases are killed + respawned by the attach path, i.e. a real START, so they ARE held) is consulted only when the wake
WOULD be held (`wakeWouldBeHeld()`): every site awaits `wakeHeldForMemory` (async), the bus sweep uses the `setWakeKeeperResident` seam (index.ts). The peer-message bring-up
(`wakeHeldMessageTarget`) wakes ONLY a still-sleeping member (an earlier site's release may already have started it — no extra content-free turn). Gates: `scripts/e2e-admission-wake.mjs` (15 arms incl. `keeper_resident` — fake keepers answering the REAL `probeKeeper`, unique ws ids per run — and `two_sites_reverse`; `RIG_REPO=<master>` = must-FAIL; `pnpm run test:admission-wake` / `test:admission-hold` / `test:admission-mutants` — both rigs are gates 4/5 + 5/5 of the release gate, `build-release.md`; concurrent drivers are isolated by `scripts/rig-isolation.mjs`; real bus + sweep + roster + prompt queue + message dispatch, fake memory source + recording seam with a boot window and a simulated inbox hook),
`admission.test.ts` W1–W18, `admission-wiring.test.ts` `#287 …` pins (the recovery site is wiring-pinned only), `admission-mutants.mjs` W-series (`rig: 'wake'`).

### Archive / unarchive / delete
- **`archiveWorkspace`** `:534` (soft: stop the Run/nvim PTYs + the SDK session, keep the worktree),
  **`unarchiveWorkspace`** `:559`, **`deleteWorkspace`** `:450` (hard: runs the
  per-repo archive script best-effort, clears the leftover pre-#233 `logs/<id>.log` + inbox, `removeWorktree`,
  removes record, broadcasts `workspace:removed`). Directory removal is
  hard-confined to `ORCHESTRA_ROOT`/`SCRATCH_ROOT`. **Sandbox-hosted** records
  (`:491`) just detach — the container keeps its copy; nothing local to reap.
  The reap steps are factored into **`teardownWorkspace(ws)`** (everything
  except the store-remove + broadcast) so both `deleteWorkspace` and the bulk
  path share them. Its first act `forgetHibernationActivity(id)` also marks the
  id `isBeingDeleted` so the hibernation sweep skips it (delete/hibernate
  serialization, #205); then **#201:** `stopStructuredSession(id)` —
  awaited `sdkStopIfLive` (drops the in-memory session) + `killKeeper(id,
  'workspace-deleted')` (kills a surviving keeper/CLI, sweeps its pid/sock) +
  `stopMemberScopeIfAny(id, 'workspace-deleted')` (#327: only a member WITH a kernel scope — kills its Reliquats
  by identity, then stops ITS scope units — `session-keeper.md`) —
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
  processes). `store.load()` resets persisted `running` → `idle`; the agent's SDK
  session lazy-starts (resuming `sdkSessionId`) on the first send or wake for the
  workspace — since #230 nothing opens an agent PTY (no Terminal tab; the renderer
  no longer mounts a terminal for the agent — `Terminal.tsx` is deleted, #231 — and the launcher itself is gone, #233). A
  LEGACY terminal-only workspace (`hasInput`, no `sdkSessionId`) has its terminal
  transcript adopted as the resume id by `adoptTerminalTranscript` on wake, restart
  AND at the session-start funnel itself (`ensureSessionInner`, #230 / #228 review O1+F1), so any Agent-view action that starts the session first resumes it.

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
| `dispatchSpawnRequest` | `:1477` | `/spawn` | Create child workspace + start it as a **structured SDK session** (`startWorkspaceAgentHeadless`). **A start that fails is reported, not masked (#227):** `ok:false` + `error` naming the reason and the kept child (`id`/`branch` also on the reply); the child stays stopped with its task, Restart retries. No PTY fallback. Inherits caller's repo (worktree callers) or requires explicit `repoPath` (scratch/orchestrator callers). Records `parentId` = caller, unless `detached:true` (parentless top-level workspace; repo inheritance from `from` still applies). Optional `model` pins the agent's model on the record (`Workspace.model`, `types.ts`) — the pty passes `claude --model` on every launch, and the SDK structured-session path must mirror it via `options.model`. **Omitted → the user's *spawned-agent default model*** (`defaultKind: 'spawned'` from `/spawn` and sandbox spawn; the UI's spawn-from-ticket click passes `'workspace'`). `createWorkspace` freezes `modelForNewWorkspace(...)` onto every new record (`src/shared/model-defaults.ts`; settings in `store.getModelDefaults()`, edited from the sidebar's Default models modal `ModelDefaultsSettings.tsx`); launch paths resolve via `resolveLaunchModel` (`default` marker = account default, no `--model`). The reasoning effort mirrors it: `createWorkspace` freezes an explicit `/spawn` `effort` (`orchestra spawn --effort`), else `effortForNewWorkspace(store.getEffortDefaults(), defaultKind)`, onto `ws.sdkEffort` (`src/shared/effort-defaults.ts`; same modal; `default` = leave unset), and the PTY launch passes `--effort` when set (the SDK path already reads `ws.sdkEffort`). The model guard is a charset/length check only — a dead model id passes it and fails at the child's own launch — a CLI that exits, or errors its first turn, before producing output now makes spawn not-ok (#227 D7); one that only retries (`api_retry`, process alive) is ok + a "not confirmed" note. **#382:** takes `namedBy` (→ `createWorkspace(…, defaultKind, { namedBy })` → `initialNaming({namedBy})` → `Workspace.namedByParent`, so `nudgeActive` is false and `ORCHESTRA_BRANCH_AUTO=0`) — set ONLY by `dispatchAgentSpawnRequest`; the pinned-Linear `--spawn` (`linear-tickets.ts:215`) and the accès-mobile launch (`acces-mobile-routes.ts:41`) never pass it nor a name, so they stay byte-identical even with `from` set (#380 D4). |
| `dispatchAgentSpawnRequest` | `:1589` | `/spawn` | **The AGENT spawn route (#382), hooks-server `/spawn` + the sandbox wire's `spawn` rpc.** `checkSpawnName(name)` (`shared/naming-policy.ts`: required, sanitised, `<rôle>-<objet>[-<ticket>]`, rôle ∈ `ROLES`) FIRST — a missing/unknown name returns `{ok:false, error}` (restating `NAME_CONVENTION`) and creates nothing (an old CLI/skill sends no `name`); then `dispatchSpawnRequest({…, defaultKind:'spawned', branch: <checked name>, namedBy: from})`. The name rides the existing explicit-`branch` input, so a collision is suffixed by `freeBranchName` and the CLI prints the FINAL branch. `namedBy` is recorded for `--detached` children too (no `parentId`). **`exactName: true`** (follow-up): the name is exact — when it and `-2…-99` are all taken the spawn is refused (`ok:false`, no id, nothing created) instead of silently landing on a random branch with `namedByParent` set; concurrent same-name spawns serialise their NAME pick in `createWorkspace` (reserved until the branch exists) and suffix (`impl-x`, `impl-x-2`, …); an existing `impl-x/sub` branch also counts as taking `impl-x`. Human paths (pinned-Linear, accès mobile) pass no `exactName` and keep the random fallback. A `/spawn` with no `from` is a human at a terminal: a human-created workspace — name required, `namedByParent` unset. **The requirement is keyed on this route, never on `defaultKind`** (D4). **Sandbox:** `sandbox-manager.ts` `dispatchRpc('spawn')` calls it too (wire `spawn.name`, vendored copy synced) — dormant while sandbox agents are paused (ADR 0007), kept so the rule has one implementation. |
| `dispatchPromoteRequest` | `:2010` | `/promote` | Make a workspace a coordinator (idempotent). **Two routes**: a scratch session swaps `kind` → `'orchestrator'`; a **git worktree keeps its kind and gains `canOrchestrate`**, so it parents children while keeping repo/branch/diff/merge/PR. **#171: promote is a re-anchoring op** — the promoted node stops resolving to its parent OPS/LEAD and becomes its OWN run, so it now `snapshotRunAnchors(id)` **before** the mutation and `reconcileRunAfterReparent(…, {noRestart:false})` **after** (both routes), exactly like attach/demote. An idle live session is restarted so its rebuilt env re-reads `ORCHESTRA_RUN_ID` + generation (removing the manual `orchestra restart` the ticket hit 4×); a working structured session's restart is refused (mid-turn guard → `{ok:false}` → mark-stale). (The old raw-PTY deferral, `preferStaleForLivePty`, left with the PTY restart — #232.) Returns `restarted`/`markedStale` like the re-parent handlers. **#221:** promoting a child of a run-less PLAIN workspace also starts that workspace's MISSION run (coordinator = itself) and nests the child's run under it — the parent stays a plain workspace (see `bus.md` §#221). |
| `dispatchDemoteRequest` | `:1384` | `/demote` | Inverse of promote. Clears `canOrchestrate` and **detaches every child** (a `parentId` pointing at a non-orchestrator renders nowhere). Refuses the `'orchestrator'` KIND — it is repo-less by nature and has no worktree to fall back to. |
| `dispatchAttachRequest` | `:1456` | `/attach` | Re-parent under a coordinator (`canOrchestrate`), or clear `parentId` to detach. **Full-ancestry cycle check**: a promoted worktree can itself have a parent, so A→B→A is reachable and the old bare self-check was no longer sufficient. |
| `dispatchSetRepoAssociationRequest` | `:1834` | `/setRepoAssociation` | File an `'orchestrator'`-KIND session under a repo's sidebar section (with its subtree), or clear it. Writes **`repoAssociation`, never `repoPath`** — see below. Refuses a git worktree (it already groups by its own repo) and any path not in `store.repos`. |
| `dispatchVerifyLandedRequest` | `~:1590` | `/verifyLanded` | **Coordinator close-out check** (read-only): are ALL commits on a child's branch **tip** reachable from the target? Target = explicit `into` ref (repo-less coordinators) or the caller's own branch (`from`, must share the child's repo — the integration-branch case). Backed by `listUnmergedCommits` (git.ts, ref-validates first so a deleted branch fails loudly instead of reading "0 unmerged"; tests in `git-verify-landed.test.ts`). Exists because a child's "done"/"merged" report decays — agents keep committing after they report. NOT LANDED is not always a defect: deliberately-unmerged work (spikes) closes as INTENTIONALLY UNMERGED — the contracts forbid only the *silent* strand. **Exit codes** (`orchestra verify-landed`): `0` LANDED · `2` NOT LANDED · `1` could-not-check, so a close-out gate can distinguish unmerged work from a failed check — never gate on `$?` being nonzero alone. See `hooks-cli-socket.md`. |
| `dispatchWhoamiRequest` | `~:1660` | `/whoami` | A workspace's own record (id/name/branch/kind, `orchestrator` via the `canOrchestrate` helper, `parentId`, repo/base). The only in-band way an agent learns its `parentId` — `/peers` excludes the caller, and a child promoted BY its parent never observes the promotion — which is what makes "at most one sub-orchestrator level" checkable by its addressee. |
| `dispatchPeersRequest` | `:1239` | `/peers` | List other live workspaces (`PeerInfo[]`; #232 DROPPED the PTY-derived `running` flag — nothing printed it: the CLI table is id/branch/[ex/]repo/status[/files/+-/note] — the `ex` column (`ex-<previous name>`, `PeerInfo.formerBranch`, #384) exists only when some peer was renamed — and the comms-resurface hook only counts `"id"` keys; `status` is the signal). `stats: true` adds each git peer's committed three-dot diff vs base (`getBranchDiffShortstat`, git.ts) — opt-in because the comms-resurface hook hits `/peers` every prompt and N git spawns on that path is the per-workspace × per-poll trap. |
| `dispatchMessageRequest` | `:1353` | `/message` | Deliver to peer: **live** (next turn of a live SDK session — nothing is ever typed into a PTY, #232), **started** (structured wake via `wakeAgentWithPrompt`; no PTY fallback — #227), or **inbox** (also what an unstartable wake lands in) (park in `~/.orchestra/inbox/<id>.txt`; the 5s post-wake insurance counts a live SDK session as delivered). |
| `dispatchRenameRequest` | `:1101` | `/rename` | `(id, branch, from?)` — asks `decideRename` (rename authority human > parent > child, #383) first; a refusal returns `{ok:false,error}` before any git/store write. See Branch management → Rename authority. |
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
  (the next launch re-reads the env); + live + **the host holds a session key for it (#379)** → `host-resolved`
  (whatever `--no-restart` says); + live + restart allowed → `restart`;
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
- **#379 / ADR 0008 — `host-resolved`: a promotion takes effect at the next CLI call.** A LIVE session whose workspace has a registered
  session key (`hasSessionKey`, `session-identity-host.ts`; the candidate's `hostAnswers`) has its bus identity answered by the HOST on every
  CLI call (`/identity`, bus.md → Session identity), so the reconcile rewrites the notice and writes the **marker file only**
  (`writeStaleRunMarkerFile` — the app-down fallback's guard, ignored while the host answers): **no restart, no `busRunStale` pane state**,
  and the id is reported in the result's `hostResolved` (promote/attach/detach/demote/adopt; the CLI prints it). This is what makes
  `orchestra spawn` → `orchestra promote` → `orchestra send` work in ONE turn. A keyless live session (a keeper born before #379) keeps the
  restart / mark-stale path below; a cold session stays `notice-only`. `buildSdkEnv` mints nothing — `ensureSessionInner` mints one key per
  session start and the keeper facade registers it only at a FRESH spawn (session-keeper.md); the three delete paths `forgetSessionKey`.
  A keeper-DETACHED keyed CLI (app restarted, session not reattached: `readTrackedKeeperPid` alive) counts as live for this decision (no restart — that would be a wake). Rig: `verify-promote-run-refresh.mjs` arms H1–H8.
- **#171 — restart refused/failed ⇒ mark-stale (not a silent warn)** (still the path for a KEYLESS live session).** When the
  reconcile's restart returns `{ok:false}` (a working structured session throws the
  mid-turn guard, or any relaunch failure) it now DOWNGRADES to `markWorkspaceStaleRun`
  instead of only logging — so the live session is never left on the OLD run without
  an operator signal (the #171 promote symptom), and never killed mid-turn (arm 2:
  "refused-or-deferred explicitly"). The reconcile asks `sdkSessionLive` only (#232: the
  old `preferStaleForLivePty` option, which forced a LIVE raw PTY down the mark-stale branch
  because the PTY restart had no mid-turn guard, left with the PTY restart). `markWorkspaceStaleRun`
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
- **The naming rule is ONE pure module — `src/shared/naming-policy.ts`** (#381, no Electron
  import; vague #380 grows it). `nudgeActive(ws)` (`:30`) — `!branchManuallySet && autoRenameCount < MAX_AUTO_RENAMES`
  (`:16`, =2) — is the single gate for the `ORCHESTRA_BRANCH_AUTO` env flag (`buildSdkEnv`, `agent-sdk.ts:882`) and the
  `${MAX_AUTO_RENAMES}` baked into the nudge hook script. `initialNaming()` (`:36`) is what
  `createWorkspace` / `createScratchLikeWorkspace` spread for a fresh record (`branchManuallySet:false`).
  `decideRename(target, caller)` (`:69`) says what a rename pins: `{kind:'human'}` → `manual` pin, no counter;
  `{kind:'agent', id?}` → the human > parent > child matrix below (#383; an unnamed workspace keeps today's rule:
  `bumpAutoCount = nudgeActive(target)`). `pinFields(ws, pin)` is what an allowed rename writes; `pinAdvancesGate(ws, pin)` (`:80`)
  says whether a same-name rename must still persist it. A source-reading wiring test
  (`src/main/naming-policy-wiring.test.ts`) fails on any inline copy in `src/main`.
- **`renameWorkspaceBranch(id, newBranch, pin: RenamePin, window)`** `:979` — scratch: relabel only; worktree:
  `git branch -m` (via git.ts `renameWorktreeBranch`). The caller passes the policy's decided `pin`; the written
  gate fields are `pinFields(ws, pin)`: `manual` (human UI edit) pins `branchManuallySet`; `bumpAutoCount` (agent
  auto-rename) instead increments `autoRenameCount`; `namedByParent` (#383, a parent's rename) pins "named by parent". Callers: `api-handlers.ts` `renameBranch`
  (`decideRename(ws, {kind:'human'})`) and `dispatchRenameRequest`. `freeBranchName` dedupes collisions with `-2..-99`.
- **`Workspace.formerBranch` ("ex-…", #384)** — the name before the LATEST rename.
  `renameWorkspaceBranch` spreads `formerBranchPatch(ws, before, after,
  pin.namedByParent)` (`shared/former-branch.ts`, pure) into each name-changing
  write (`before` = the DISPLAYED name `ws.branch` everywhere — what ledgers and bus messages quote; a drifted live
  branch nobody saw is NEVER recorded; a request equal to the displayed name while live differs realigns git but
  changes no displayed name, so records nothing). Recorded only on an ACTUAL change of a
  workspace that is parent-named before (`namedByParent`) or after (`pin.namedByParent`
  — the rename pins it) — a human-created workspace's provisional self-renames
  record nothing (D3). A later rename REPLACES it; a same-name no-op and the
  `gateFields`-only branches leave it; the patch is `{}` (never `formerBranch:
  undefined` — `workspace:update` is a merge). Persisted whole by `store.upsertWorkspace`
  (store.json is `JSON.stringify(data)`, no field whitelist). Read by `dispatchPeersRequest`
  (`PeerInfo.formerBranch` → the CLI `ex` column) and the sidebar tooltip
  (`withExLabel`, both row paths). Gates: `former-branch.test.ts` (pure table),
  `former-branch-rig.test.ts` + `scripts/e2e-former-branch.mjs` (real worktrees, real
  store, fresh-process reload), `peers-former-branch.test.ts` (built CLI vs a socket stub),
  `former-branch-wiring.test.ts`. Three writes record: scratch relabel, git rename, and the DRIFT-adoption write
  (requested name == live branch, stored name stale). The out-of-band reconciler
  `detectAndUpdateBranchName` (`activity.ts`, a hand-run `git branch -m`) records too. NOT recorded, on purpose:
  `switchWorkspaceBranch` (checks out a DIFFERENT branch — not a rename of this workspace) and a same-name no-op.
- **Progressive auto-rename** — the agent gets **two** staged auto-renames: an early provisional name, then a
  refined name once the work is well-defined. `dispatchRenameRequest` (`:1101`, `from?`) asks
  `decideRename(ws, {kind:'agent', id: from})` — the rename counts only while the nudge is active. After the budget
  is spent the nudge retires, but an unnamed workspace's agent can still rename on demand; a spawned agent named by
  its parent cannot (below).
- **`branchManuallySet`** = human-pinned (UI edit, out-of-band `git branch -m` adopted by
  `detectAndUpdateBranchName` in activity.ts, `switchWorkspaceBranch` — all three pin through
  `decideRename(…, {kind:'human'})` + `pinFields`); hard-stops the nudge for
  good. **`autoRenameCount`** tracks the agent's own progressive renames.
  `.orchestra/.branch-renamed` sentinel holds the live count so the hook advances
  stage / self-disables mid-session before a session restart refreshes the env.
- **Rename authority — human > parent > child (#383; policy = `src/shared/naming-policy.ts` `decideRename`, `:129`).**
  Target states: **U** unnamed (no `namedByParent`, no human pin — human-created or legacy agent), **P** named by
  parent (`namedByParent` = the namer's id), **H** human-pinned (`branchManuallySet`). "Parent" = the caller's id is the
  target's `parentId` OR its `namedByParent` (a `--detached` child has no `parentId`); an absent/empty `from` is an
  UNKNOWN caller, never a parent. The sidebar (`api-handlers.ts` `renameBranch` → `decideRename(ws, {kind:'human'})`)
  is the `human` caller and always lands. For an agent (`dispatchRenameRequest`, `:1101`; `from` = the caller's
  `ORCHESTRA_WS_ID` on `/rename`): U + anyone = today's rule (counter bump while the nudge is active), except **U +
  parent** → lands and pins P (`namedByParent` = caller; no bump — this is also how the migration works, the script
  impersonates the parent); **P + parent** → lands, stays P, no bump; **P + self/other/unknown** → refused "named by
  your parent (<name>) — ask them to run `orchestra rename`" (the name comes from the policy's pure `namerName(target, lookup)`: the parent's branch, else the namer's; when NEITHER resolves — a dangling `namedByParent`, the namer was deleted — the text is "named by your parent, who no longer exists — it can be renamed from the sidebar"); **H + `namedByParent` set, or H + the target's parent**
  (D6; a human pin binds the parent even on a legacy child nobody named) → refused "named by the human"; **H without
  `namedByParent`, caller not the parent** (human-created / legacy) → as today. An OUT-OF-BAND `git branch -m` is adopted
  by `detectAndUpdateBranchName` (`activity.ts`) with `adoptedBranchPin`: on a parent-named, not-yet-human-pinned workspace
  it adopts the name but pins NOTHING (a refused child cannot mint a human pin and lock its parent out); elsewhere a human pin. **Known cost (D7, LEAD-accepted):** a HUMAN's own `git branch -m` inside a parent-named worktree is indistinguishable from the child's, so it no longer pins either — the human pin path is the sidebar rename. A
  parent pin also writes the `.branch-renamed` sentinel at `MAX_AUTO_RENAMES`, so a LIVE child session's nudge hook
  retires on its next prompt. The decision is pure (table-tested in `rename-authority.test.ts`,
  mutants `scripts/rename-authority-mutants.mjs`); `renameWorkspaceBranch` only applies the pin it is handed
  (`manual` / `bumpAutoCount` / `namedByParent`). Wiring pinned by `rename-authority-wiring.test.ts` (no inline copy
  of the matrix in `workspaces.ts`) and by `naming-policy-wiring.test.ts`: the no-inline-copy detector also flags a bare `.namedByParent` read
  (statement-exact allow-list + `former-branch.ts`), a caller identity compared with a `parentId`, and ANY authority-field read inside the
  rename surfaces (the `/rename` route, the sandbox rpc, the adoption, the sidebar handler, `dispatchRenameRequest`, `renameWorkspaceBranch`).
- **`switchWorkspaceBranch(id, branch, window)`** `:3412` — `git switch`, stop
  the SDK session (`sdkStopIfLive`, lazy restart on the next send) and the nvim PTY, set
  `hasInput:false` + `branchManuallySet`, emit `pty:restart` for NVIM only (#232: no agent `pty:restart`
  and no "pending coordinator replacement" mark — the SDK restart bumps the generation itself).

### One-shot migration of parent-given names (#385, spec #380)
`scripts/migrate-parent-names.mjs --table <t.json> [--apply] [--closed <ops-id>,…] [--allow-gone] [--assume-app-current] [--live] [--verbose]` (every table row needs `id`, `old` and `new`: `old` is what tells a lost former name from a never-renamed workspace on a repeated run) renames EXISTING spawned agents
to the `<rôle>-<objet>[-<ticket>]` convention; it runs ONCE on the live fleet, so every anomaly stops it on the safe side. The pure planner `planMigration`
(`src/shared/naming-migration.ts:162`) takes the store's workspaces, the branches on every remote (+ local), the worktrees' LIVE heads, the ids of a running
vague and the human-validated table `[{id, old?, new}]`, and returns one action per workspace — `rename`, `skip-remote` (branch on a remote), `skip-vague`,
`skip-live-head` (the worktree is on another branch than the store says, or HEAD is unreadable / the worktree cannot be seen / a sandbox host: the app renames the LIVE branch, so UNKNOWN is not planned),
`skip-base` (another live workspace of the repo — the same repo under two spellings is one — has this branch as its `baseBranch`: its Diff/stats would dangle; a pin-only step changes no name and is held by none of `skip-remote` / `skip-vague` / `skip-base`), `done` (named AND parent-named), or
`untouched-*` (human-created = no recorded spawner; no parent to name it; archived — `dispatchRenameRequest` answers "unknown workspace"; not in table) — plus
REJECTED rows (unknown id, duplicate row/target, refused by `decideRename` (a human-pinned name — asked of the real policy, as the parent, or as a hypothetical
parent when none is recorded; a workspace already named and parent-named stays `done`), `checkSpawnName` failure (which also refuses git-invalid refs and `/`),
stale `old` (only when parent-named differently since; a child that renamed ITSELF, or whose former name is `old`, is not stale), name taken — also as a ref
path-prefix: the app would silently suffix it; an ARCHIVED workspace's row only has to be well-formed). A parent that left the store still names its child
(`decideRename` compares ids only). A running vague = `activeVagueMemberIds` (`src/shared/naming-migration.ts:119`), the app's own `liveFleetRuns` rule
read off the store (a live OPS with a parent and a live member below — through `parentId` OR the namer, so a `--detached` verifier is held too; nothing writes
`runs.closed_at`, the bus is never opened; a top-level orchestrator is a mission, its workers are not held). The app has no close event and archiving an OPS
archives its WHOLE subtree (`archiveWorkspace`), after which no rename is possible — so the operator declares a finished-but-live vague with `--closed <ops-id>`
BEFORE archiving (the `skip-vague` PLAN line says so and prints the FULL id of every holding anchor — a member below two vagues needs both closed; `--closed` takes a full id or a unique prefix of 6+ characters, an ambiguous one lists the candidates); a table row of an archived workspace is a WARN and an apply with one is not green unless `--allow-gone`.
The script reads only (store at the CLI's `appStoreFile` path, `git ls-remote`/`for-each-ref`/`symbolic-ref`; any unreadable input = rc 2, never an empty set), is a
dry run unless `--apply`, refuses when `ORCHESTRA_SOCK` is set or ANY row is rejected (`--allow-gone` excuses only the rows that can never apply — a workspace that no longer exists is GONE, an archived one is ARCHIVED rather than a WARN — never a rejected row), and on the LIVE
fleet: `ORCHESTRA_HOME` UNSET (= `~/.orchestra`) refuses `--apply` unless `--live`; any EXPLICIT spelling of the live home (explicit, relative, symlinked) or a home carrying
the live app's socket pointer is refused outright (rc 2), EVEN WITH `--live` — the live packaged app runs WITHOUT `ORCHESTRA_HOME`, so its store is the XDG one, not `<home>/userData` (checked before
anything is read; the header names the home, store and socket pointer it acts on). A `--closed` that names no running vague's OPS prints a NOTE (it releases nothing). It PREFLIGHTS the app (the verdict prints in a dry run; only `--apply` refuses): the startup banner of `<home>/logs/orchestra.log` (the whole
file, the instance running on THIS home) must be a live process whose version is at least the checkout's (a release installed but the app not restarted renames
WITHOUT pinning); older or a suffixed build of the same number refuses rc 2 ALWAYS; unknown (the log rotates at 5 MB) or dead refuses rc 2 unless `--assume-app-current` attests the
restart (it never overrides a banner that reads older). The floor is the CHECKOUT's version, so run the script from the checkout of the release that ships #383/#384 (a pre-release branch carries an older number;
the canary below bounds a miss to one row). It applies each step ONLY as `orchestra rename <id> <name>` with `ORCHESTRA_WS_ID=<parentId, else namedByParent>` (D2) — it never writes `store.json`. After each
rename it RE-READS the store and the worktree's git HEAD (read-only) and requires the VALIDATED name, `namedByParent` (the EXISTING namer when there is one —
`decideRename` keeps it — else the parent acted as), a former name, and git on the target. A CLI error alone (the git lock) is a FAILED row and the others go on — but a timeout (state UNKNOWN) or two CLI errors in a row stop the run; a
rename the CLI answered "Renamed to" but the store does not show recorded (an app that cannot pin, a child that won the race, a suffixed name, git behind the
record) ABORTS the run at that row — the first row is the canary, nothing after it is touched — rc 1; the re-run picks it up (the name is ours without the pin → a
pin-only same-name rename, reported FORMER-LOST (rc 1, never a green APPLIED) when the former name is unrecoverable; the child's name won → a rename; the app
suffixed it → the target decides). One last look after the run catches a child's late rename; the DONE line counts what was skipped. Idempotent: after a full apply `renames` is empty. Gates:
`naming-migration(.script).test.ts`, mutants `scripts/naming-migration-mutants.mjs`, built-app drive `scripts/e2e-migrate-parent-names.sh`.

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

## Secrets — secrets.ts, linux-keyring.ts, shared/password-store.ts (#389)
`secrets.ts` stores the Linear key, each account's Anthropic API key and base URL in
`<userData>/orchestra/secrets.json` (0600): per entry `{value, enc}` — `enc:true` = base64
`safeStorage` ciphertext (platform seam `encryptString`/`decryptString`), `enc:false` = plaintext
fallback with a warning when `isEncryptionAvailable()` is false. Every mutation runs under one
`serial()` lock and lands via tmp-file + `rename` (a failed write leaves the previous bytes);
the first disk read is single-flight (`loading`).
- **Backend selection (before `ready`)** — on Linux Chromium picks `basic_text` on a desktop it does
  not recognise (sway, Hyprland…), so safeStorage is unavailable and every secret is plaintext even
  with a keyring on the bus. `shared/password-store.ts` is the PURE rule (`decidePasswordStore`):
  explicit `--password-store` wins → no reachable session bus → recognised desktop
  (`isRecognisedDesktop`: `XDG_CURRENT_DESKTOP`/`DESKTOP_SESSION` tokens + `KDE_FULL_SESSION` etc.,
  Chromium keeps its choice) → probe: `gnome-libsecret` ONLY for an UNLOCKED default collection;
  locked (libsecret would wait on a prompt nobody answers, a ~76 s stall) or no service → Chromium's
  choice. `linux-keyring.ts` owns the impure half: `probeSecretService` (`gdbus … Properties.Get
  org.freedesktop.Secret.Collection Locked` on `/org/freedesktop/secrets/aliases/default`, read-only,
  synchronous but WAIT-ONLY — it never abandons an in-flight call: a client vanishing mid-`Properties.Get` aborted the human's gnome-keyring-daemon
  twice on 2026-10-26. `WAIT_ONLY_SH` runs gdbus (`--timeout 30` per call: it sends an `Introspect` first, then the Get) in the background and
  polls it every 10 ms against a WALL-CLOCK deadline (`/proc/uptime` via the `read` builtin: no fork, so a failing `sleep` under process pressure cannot
  end the wait early) of `PROBE_WAIT_MS` = 5 s; past that it exits 3 WITHOUT signalling — `unavailable`, Chromium's default, the orphaned child finishes
  its own call. Worst case a dead daemon blocks the main thread 5 s. A wrapper `kill` / `timeout` / SIGTERM-SIGKILL spawnSync timeout is the
  mutant). The probe's output file needs a writable scratch dir: `makeProbeDir` tries `os.tmpdir()`, then `$XDG_RUNTIME_DIR`, then the userData dir
  (`extraScratchDirs`, index.ts); each failure is logged as `probe-notes="mkdtemp <base>: <code>"` in the startup line, none writable ⇒ `unavailable` (round-4 MINOR).
  `classifyProbeAttempt` (round-6 PRODUCT): ONE retry (`MAX_PROBE_ATTEMPTS` = 2, after 100 ms, inside the same overall wait) only for an IMMEDIATE failure (< 50 ms) that is
  not a reply — a spawn error of `sh`, a connect failure, a premature wrapper exit — never for a real answer, a `GDBus.Error:` bus reply (a real "no service"),
  or the deadline; gdbus stderr goes to a file and every abnormal attempt (status/errno + first stderr line) is reported in `probe-notes`.
  `selectLinuxPasswordStore` (appends the switch; `index.ts` calls it at module scope, never in CLI
  mode, and logs `[secrets] password-store: … — <reason> (probe N ms) [desktop=… bus=…]` after
  `initLogger`). **Electron sets `DBUS_SESSION_BUS_ADDRESS=disabled:` in its main process when the
  launcher exported none** — that is "no address" (`usableBusAddress`); the bus is then
  `$XDG_RUNTIME_DIR/bus` (`sessionBusKind`), the probe is pointed at it (`probeEnv`) and, when libsecret
  is selected, the address is exported into `process.env` (`exportBusAddress`) — without it libsecret is
  selected but safeStorage stays unavailable (rig arm `unlocked`, verified).
- **Isolated instances never bind to the human's keyring (review F1)** — `isIsolatedInstance(env)`: `ORCHESTRA_HOME` set
  (the packaged app never sets it; every built-app rig and `pnpm run dev` does) ⇒ reason `isolated-instance`, `--password-store=basic` FORCED (Chromium's own
  choice on a recognised desktop — GNOME/KDE — would still bind the real keyring), NO probe, NO bus export — otherwise a rig run with the
  real `XDG_RUNTIME_DIR` would seal scratch secrets through the human's login keyring and carry his bus. Settings words it truthfully:
  `setKeyringSelectionReason` (index.ts) → `SecretsState.selectionReason` → the notice says "isolated home (ORCHESTRA_HOME) … set
  ORCHESTRA_KEYRING=probe", not "no keyring is available". Behaviour change: a dev/scratch home on a RECOGNISED desktop
  (GNOME/KDE) used to seal through libsecret/kwallet by Chromium's own choice and now uses `basic` — entries sealed earlier are
  unreadable there (API-key accounts then fail closed); no change on sway, where it already was `basic_text`. `ORCHESTRA_KEYRING=probe` opts in (only `scripts/e2e-keyring.sh`, which brings a private bus).
- **Fail closed (review F3)** — `getAccountApiCredentials(id)` is the ONLY way agents (`agent-sdk.ts` `buildSdkEnv`) and the usage
  probe read an API key: a key whose base URL is stored but undecryptable (a locked keyring after the key was re-typed in plaintext) is
  `withheld: 'base-url-unreadable'` — never sent without its gateway URL; a stored-but-undecryptable key is `key-unreadable` (the
  usage text says so, not "no API key stored"). Do not call `getAccountApiKey`/`getAccountBaseUrl` from a new consumer.
- **File hygiene (review F2)** — a load sweeps `secrets.json.<pid>.tmp` (a killed writer's leftover plaintext copy, next to the
  link target when `secrets.json` is a symlink; anchored name match, non-recursive); a symlinked `secrets.json` is written THROUGH
  (`writeTarget`: the directory is `realpath`ed first, relative links resolve from it, the link survives). Known limit: a link whose
  target DIRECTORY is read-only cannot get its temp file there — the save fails loudly (EACCES), the previous bytes are untouched.
- **Usage text** — `accountKeyMissingMessage(withheld)` names "stored but unreadable" / "withheld: base URL unreadable" without
  blaming a cause (locked wallet, no bus, other keyring all land there); it is data on `AccountUsageStatus.errorMessage` — the badges
  still key on `errorKind` alone.
- **Re-encryption at startup** — `reencryptPlaintextSecrets()` (fired after the window in `index.ts`):
  a no-op that never touches safeStorage when nothing is plaintext; skipped while encryption is
  unavailable; otherwise each plaintext entry is replaced only by ciphertext that DECRYPTS BACK TO THE
  SAME VALUE, a failing entry stays plaintext (retried next start), and the file is rewritten once,
  atomically. Ciphertext written under a keyring that is gone next boot is kept untouched (unreadable
  until the keyring is back).
- **State for Settings** — `getSecretsState()` → `SecretsState {encrypted, backend, plaintextEntries,
  encryptedEntries, selectionReason}` (`shared/secrets-state.ts`), IPC `secrets:state` / `window.orchestra.getSecretsState()`.
  `secretsNotice(state)` is the pure rule for the warning ("Secrets are stored unencrypted on this
  machine…", plus an "N stored secrets are encrypted and unreadable until a keyring is available again"
  variant — no cause named); `SecretsNotice.tsx` renders it (nothing when encrypted) in the Linear and Accounts dialogs.
  `isSecretStorageEncrypted` (`accounts:secretsEncrypted`, the old boolean) is kept.
- **Rigs** — `scripts/e2e-keyring.sh` → `e2e-contained-rig.sh` (built app, own sway, ALWAYS in the hidden world: `RIG_HIDE_REAL_RUNTIME=1`
  makes the human's runtime dir an empty tmpfs; the driver `scripts/e2e-keyring.mjs` reads NO real bus / keyring daemon / keyring file and never
  scans `/proc/*/environ` — incident Q2, ledger #405). Each arm = its own `XDG_RUNTIME_DIR` `<rig>/xdg/k-<arm>` (bus socket + the daemon's
  control/pkcs11 sockets; the wayland alias is symlinked in), a PRIVATE `dbus-run-session` (config with one empty `servicedir`), a private
  gnome-keyring-daemon under scratch XDG dirs; arms forged (must-FAIL preflight: forced real XDG/DBUS/env value ⇒ `--preflight-only` REFUSED rc 3,
  nothing started) / unlocked / locked / nosvc / recognised / hung / gnome / relock / isolated / isolated-gnome. World clauses are PURE in
  `shared/keyring-rig-world.ts` (driver env — `%hh`-decoded, malformed escape ⇒ refuse; the hidden world PROVEN from `/proc/self/mountinfo`: a fresh
  private tmpfs stacked on the human's runtime-dir mount — its own device (a bind of the real dir shares it), no propagation tags, nothing mounted on it — env var only
  the precondition; PHYSICAL preflight through `scripts/lib/rig-paths.mjs` — a
  symlinked xdg / RIG_DIR / env value — dangling link chains followed hop by hop, `%hh`-decoded — is refused; scratch guards run BEFORE any mkdir; arm world, bus config, secrets owner = our daemon by exe + a socket
  under `<run>/keyring` with its own scan positive control, app-tree fds/env resolved to socket PATHS (paths from `/proc/net/unix`, byte-exact; `ss -xnaeH` only for which inode is connected to which — candidate splits, a marker + well-formed `ino:/dev:/peers:` tail required after the peer inode, never
  pattern-stripped; an unplaceable row that mentions one of the arm's own inodes aborts after 3 snapshots, a stranger's odd row is tolerated and counted; fd links are only `socket:[N]`) + positive control, rig-root census), tested in `keyring-rig-world.test.ts` / `main/keyring-rig-driver.test.ts` (black-box
  `--preflight-only` + source pins); processes are tracked by (pid, start time) from the private bus peers / app tree. Mutants
  `scripts/keyring-mutants.mjs` (unit; U*, W* world, D* driver/launcher) and `scripts/e2e-keyring-mutants.mjs` (built-app copies). Traps:
  gnome-keyring needs `--login` (password on stdin) THEN `--start` to publish `org.freedesktop.secrets`; the oracle uses `gdbus --address`
  (never `--session`); `/proc/<app>/environ` is clobbered once a bus address is set (Chromium rewrites its title).

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
