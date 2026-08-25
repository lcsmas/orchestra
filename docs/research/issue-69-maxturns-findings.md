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
