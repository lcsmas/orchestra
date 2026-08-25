# Issue #69 — maxTurns exhaustion: root cause (verified at master 2ebd3fb)

## Mechanism (three independent defects, NOT one)

1. **The budget is cumulative per `query()`, not per turn.**
   `src/main/agent-sdk.ts:1339` sets `maxTurns: 200` on the single `query()` a
   session opens. SDK type doc (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1723`):
   "Maximum number of conversation turns before the query stops." Orchestra
   streams EVERY turn of a session's life through that one `query()`
   (`promptStream`, agent-sdk.ts:847), so 200 is a session-lifetime budget. The
   in-source comment "A large cap: real turns end on their own; this only
   backstops runaways" is FALSE for a long-lived coordinator: every fleet ping
   is a turn.

2. **Exhaustion is a `result` message, not a throw — so the queue is not drained.**
   `error_max_turns` arrives as `SDKResultError` (sdk.d.ts:4603) on the stream.
   `consume()`'s `catch`/`finally` (agent-sdk.ts:964-1060) — which is what emits
   "N queued messages were not delivered" and settles senders — NEVER RUNS.
   Instead the `msg.type === 'result'` branch (agent-sdk.ts:952) opens the
   turnGate, `promptStream` yields the next queued turn, and it dies on the same
   exhausted budget immediately. Queue drains into a black hole, one entry per
   round-trip, with senders holding 'Delivered (live)' receipts.

3. **The state never reaches the UI.** `sdkEventToStopReason` carries
   'max_turns' into `applyAgentEvent` (activity.ts:653) → `fireFinished`
   (activity.ts:146). `fireFinished` calls `setStatus(id, 'idle')` — the SAME
   status as a clean finish — and the only differentiation is a transient OS
   toast at activity.ts:198 that is SUPPRESSED when the window is focused
   (`if (focused || ws.loopingSince) return;`). Nothing is persisted: grep of
   src/shared/types.ts for a "why did the last turn end" field on Workspace
   returns nothing. So the sidebar shows a normal idle dot forever.

## Consequence
A coordinator that exhausts its budget looks IDLE (indistinguishable from
"finished, ready for review") while silently eating its queue. That is exactly
the field failure in #69.

## The fix (chosen mechanism, and what was rejected)

**Chosen: recycle the `query()` on exhaustion, with a runaway guard, plus
persist the terminal stop reason for the UI.**

The decisive fact is that `maxTurns` is fixed when `query()` is constructed and
has no setter. So:

- REJECTED — *raise the cap / per-workspace override.* Moves the wall without
  removing it: a coordinator that runs for days reaches 2000 exactly as it
  reached 200, and the failure at the new wall is identical and just as silent.
  It also requires guessing how many turns a role "should" need, which nothing
  in the app knows.
- REJECTED — *reset the budget per user-initiated turn.* Unimplementable against
  this SDK for the reason above. The only thing that actually resets the budget
  IS a new `query()` — so "reset per turn" and "recycle" are the same mechanism,
  and recycling is the honest name for it.
- CHOSEN — *recycle.* Lossless because `ws.sdkSessionId` is persisted
  continuously and passed back as `resume`: the replacement query continues the
  SAME conversation with a fresh budget. This finally makes `maxTurns` do what
  its comment always claimed — backstop a runaway — because a runaway is now
  caught by a RATE guard (3 recycles / sliding hour, `src/shared/turn-budget.ts`)
  rather than by a raw cumulative count that punishes longevity instead of
  runaway-ness.

### The UI half (the non-negotiable)

`fireFinished` set `status:'idle'` for EVERY terminal reason, and the only
differentiation was an OS toast suppressed whenever the window is focused — so
the user sitting in front of the app was precisely the one it never reached.
`Workspace.lastStopReason` is now persisted on the same store write and
broadcast as the status, and the sidebar glyph renders it as a distinct SHAPE
(octagon-alert) ranked above the autoUnread bell.

## Rig defect found by mutation (worth recording)

The first version of the guard "the fix is wired into agent-sdk.ts" asserted
only that the identifier `shouldRecycleForBudget` appeared somewhere in the
file. Deleting the CALL SITE from the consume loop left the policy function's
own definition — which contains the name — so the guard passed on a build where
the fix was inert and the queue starved exactly as before. VACUOUS for the one
regression it existed to catch. Fixed by slicing `consume()`'s body (with a
positive control that the slice is non-empty and contains the turn gate) and
asserting on `recycleForBudget(` as a CALL. Re-ran the mutant: now killed.

Full mutation matrix, one mutant at a time (an N-fix revert proves only that
SOME fix is load-bearing):
| Mutant | Killed by |
|---|---|
| remove `recycleForBudget` call site | GUARD wired-into-consume (only after the fix above) |
| remove `lastStopReason` from Workspace | GUARD stop-reason-persisted |
| runaway threshold → 99999 | runaway-guard + both policy tests (3 failures) |
| remove window pruning | prunes-outside-window |
| `stopReasonNote` returns non-null for clean turns | decorates-only-what-matters |

## A second bug, found by reviewing my own diff (not by a test)

The first draft of `recycleForBudget` guarded re-entry with
`if (session.stopping) return`. That is WRONG at the await seam, and it is the
#57 shape again: `stopping` is only set later, by the `sdkStop` inside the
recycle, while the consume loop keeps delivering messages across every await
before that. A second `error_max_turns` — which is exactly what you get when
queued turns each die instantly on the same spent budget — would see
`stopping === false`, re-enter, splice an already-empty queue, and race a second
`sdkStop`/`ensureSession` pair against the first, tearing down the replacement
session the first call had just booted.

Fix: a `recycling` flag on the SESSION (not a module global — a module global
routed across an await is what broke #57), assigned SYNCHRONOUSLY before the
first await. Guarded two ways: an executing race test whose CONTROL arm
(late-flag) returns 2 rather than 1, proving the rig can express the bug; and a
source-binding guard asserting `session.recycling = true` appears at a lower
index than the first `await` in the real function. Mutant (move the assignment
after the persist await) → the source guard fails. Killed.

Worth stating plainly: no test I had written would have caught this. It came
from re-reading the diff for await seams.

---

# CORRECTION (measured against the REAL SDK, 2026-08-25) — my first mechanism was WRONG

Everything above between "Mechanism (three defects)" and the fix rationale was
derived by READING `sdk.d.ts` and the source, not by driving the SDK. I then
drove it. Two of the three claims survive; the headline one does not.

## Rig
`/tmp/mtprobe/probe*.mjs` — real `query()` against the installed CLI, haiku,
`allowedTools:['Bash']`, streaming-input generator (Orchestra's mode), prompts
crafted to require >1 agentic round-trip so a small `maxTurns` actually binds.

## What I measured

| Claim | Verdict |
|---|---|
| `error_max_turns` arrives as a `result`, not a throw | **TRUE (first occurrence)** — `THREW: null`, result seen, next prompt ran |
| The budget is CUMULATIVE per `query()` (session-lifetime) | **FALSE — REFUTED** |
| A post-exhaustion queue starves | **TRUE, but by a DIFFERENT mechanism** |

**REFUTED — cumulative budget.** With `maxTurns:1` and three prompts that each
need 2 round-trips, P1 returned `error_max_turns num_turns=2` and P2 then
*independently* returned `error_max_turns num_turns=2`. A spent turn does not
poison the next one; the counter resets per turn. `maxTurns:3` likewise
completed a task with `num_turns=6`. So "200 is a session-lifetime budget" —
the headline of my commit and of my first ledger comment — is simply wrong, and
the in-source comment I called false ("a large cap; only backstops runaways")
is closer to right than I was.

**THE ACTUAL DEFECT — the SECOND exhaustion throws and kills the queue.**
Reproduced twice, identically (probe5 3 prompts, probe6 5 prompts):

```
result#1 error_max_turns num_turns=2
result#2 error_max_turns num_turns=2
THREW: Error: Claude Code returned an error result: Reached maximum number of turns (1)
results: 2 | prompts yielded: 5
```

The 1st exhaustion is a benign result. The 2nd tears the whole `query()` down
with a throw, and **every prompt still queued behind it is never consumed** —
P3/P4/P5 were yielded by the generator and silently discarded. THAT is the
starved queue in #69: not a slow drain into a black hole, but a hard kill on
the second exhaustion that takes the remaining queue with it.

Because it IS a throw, it lands in `consume()`'s `catch`/`finally` — which does
emit "N queued messages were not delivered" and settles senders. So the queue
is not silently eaten at the SDK seam. What was genuinely missing is defect (3),
which stands: `fireFinished` lands every terminal reason on `idle`, and the
only differentiator was a focus-suppressed OS toast, so the human saw a normal
idle dot and no reason. The `[WARN]` in the app log was the only record — which
is exactly what #69 reports.

## Consequence for the fix

- The UI half (`lastStopReason` persisted + rendered) is **unaffected and still
  correct** — it addresses the defect that survived measurement, and it is the
  ticket's stated non-negotiable.
- The recycle half was designed against a refuted premise and its *stated*
  justification is wrong. It is not useless — recycling on exhaustion still
  converts a hard query-death into a resumed session, which is a real
  improvement for the second-exhaustion case — but it must be re-argued from
  the measured behaviour, and the rate guard's rationale ("200 is a lifetime
  budget") has to go.
- **A number I published and would have been quoted**: "200 turns is hours of
  honest coordinator work" sized the 1-hour window. It rests on the refuted
  cumulative model. Unbaselined — I have no measurement of a real coordinator's
  turn rate.

## Final shape of the fix (post-correction)

1. **Result branch** (`consume()`): a first `error_max_turns` only sets
   `session.sawMaxTurns`. It does NOT recycle — measured, that exhaustion is
   benign and the next turn runs fine; reacting would tear down healthy
   sessions.
2. **Catch**: sets `budgetDeath` when BOTH `sawMaxTurns` is set AND the thrown
   message matches `isMaxTurnsFailure` — either alone would misfire (a stale
   flag from a benign exhaustion many turns earlier; or an unrelated error that
   merely mentions turns).
3. **Finally**: detaches the queue, lets the NORMAL teardown run to completion,
   then hands the carried entries to `recycleForBudget`. Deliberately not an
   early `return` — a `return` inside `finally` swallows the in-flight
   exception and skips `sessions.delete`, stranding a dead session in the map
   for `ensureSession` to hand back as live. (I wrote that bug, then guarded it.)
4. **`recycleForBudget`**: resumes from `ws.sdkSessionId` (same conversation,
   fresh query) or refuses as a runaway; either way it emits a notice, and on
   the post-teardown path it settles+reports the carried entries rather than
   pushing them onto a queue nothing reads any more.
5. **UI**: `Workspace.lastStopReason` persisted on the same store write and
   broadcast as the status; sidebar renders a distinct SHAPE above the bell.

## Why the tests almost lied, twice

- The "fix is wired in" guard first matched the identifier anywhere in the
  file, so deleting the CALL SITE left the policy function's own definition and
  it passed on an inert build.
- After measurement moved the recovery from the result branch to catch/finally,
  that same guard **stayed green through the relocation** — it was not binding
  what it claimed to bind. It now asserts the call appears AFTER `} catch`.

Both were found by mutation, not by reading. Current matrix (one mutant at a
time, all killed): remove catch/finally recovery; drop `sawMaxTurns`; reinstate
the bare `return` in `finally`; move the `recycling` flag after the first
await; drop `lastStopReason` from `Workspace`.

## Standing caveat

The reproduction in `src/main/turn-budget-starvation.test.ts` is still a MODEL
(agent-sdk.ts can't be imported by `node --test`). It is now built from measured
behaviour rather than from a reading, and source-binding guards refuse a verdict
if the real file stops matching — but nothing here executes the true
`consume()`. The probe scripts under `/tmp/mtprobe/` are the thing that actually
drove the SDK; they are not committed (they hit the live API and cost money to
run).
