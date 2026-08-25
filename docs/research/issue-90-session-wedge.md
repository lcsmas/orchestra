# Issue #90 — why a LIVE session stops starting turns, and what fixes it

**Date:** 2026-08-26. **Base:** `master` @ `266990e`. **Branch:** `impl-session-wedge-90`.
**Rig:** `scripts/e2e-session-wedge.sh` (drives the REAL `promptStream`/`consume`
through the repo's `__setQueryFactoryForTests` seam — the same seam
`scripts/e2e-r2-repro.mjs` uses; not a model).

## The defect

`promptStream` (`src/main/agent-sdk.ts`) is a pull-based async generator. Each
iteration arms a one-shot gate before yielding:

```
if (turnInFlight) await turnInFlight;          // park:gate
while (queue.length === 0) await …pump…        // park:pump
const msg = queue.shift();
turnInFlight = new Promise(res => session.turnGate = res);
settleDelivery(msg.uuid, true);
yield msg;
```

On the normal delivery path `session.turnGate` is resolved in **exactly one
place**: `consume()`'s `if (msg.type === 'result')` branch. The only other
callers are teardown-only (`sdkStop`, `consume()`'s `finally`).

**So a turn that is yielded but whose stream never produces a `result` parks the
generator at `await turnInFlight` permanently.**

## Why every external probe reads HEALTHY

This is what made the field incidents so hard to call:

| Probe | Reads | Because |
|---|---|---|
| `sdkSessionLive(wsId)` | **live** | `sessions.has(wsId)` is untouched |
| control requests (reload-skills, interrupt, setModel) | **answer** | they use `session.q`, a *different channel* from the prompt generator |
| `session.pump` | `null` | the generator is parked at the GATE, not the pump — so every later `sdkSend`'s `session.pump?.()` is a silent **no-op** |
| delivery | `timeout` → withdrawn | `sdkSendAwaitingStart` waits `DELIVERY_START_TIMEOUT_MS`, the entry never reaches `yield`, `dequeueUnstartedTurn` withdraws it |
| the message | parked in the inbox | `dispatchMessageRequest` → `requiresInboxFallback` → `queueInbox` |
| sidebar status | `idle` | no `submit`/`pretool` events flow |

The last two close the loop: **the inbox is drained by the `UserPromptSubmit`
shell hook, i.e. only by a turn starting.** A parked message therefore cannot
wake the agent. Self-sustaining freeze.

## Field captures (2026-08-25, both on v0.5.261)

- **ws `4dd3b098`, 20:16–20:51Z** — 3 delivery timeouts over 35 min, ZERO output,
  session alive (`reload-skills` answered 20:54:35Z), status `idle`, recovered
  only by a re-kick.
- **ws `1cf571a2`** (the wave coordinator) **22:01–22:37Z** — 3 parked deliveries,
  idle, ~35 min zero output, then a later delivery landed LIVE and it resumed.

Every observable above is reproduced by the mechanism, in the `wedged` rig arm.

## What is REFUTED / UNEXPLAINED — the part that earns this doc

- **REFUTED: "keeper reattach with `turnInFlight=true` preserves the stuck
  state."** It does not. `makeKeeperSpawn`'s `onAttached` only emits a
  `session/attach` event for the UI fold and the status dot; it never touches
  `session.turnGate`. A reattached session starts **ungated**.
- **REFUTED: "an app restart might not clear it."** It always clears it:
  `turnInFlight` is a `let` local to each `promptStream` invocation, so a fresh
  session starts `null`.
- **UNEXPLAINED, deliberately: which upstream condition ate the `result`.**
  A lost `result` and a very long turn are not discriminable from the two field
  captures — both recovered on a *later* delivery, and a later delivery does not
  itself release the gate. **This is precisely why layer 2 is cause-agnostic**;
  a fix that depended on settling this would only cover the shapes already seen.
- **The 20:52:33Z `loop detected` line on occurrence 1**: noted, NOT investigated,
  NOT claimed as cause.

## The fix, in two independent layers

1. **Root cause** — `decideGateRelease` (`src/shared/session-wedge.ts`), driven by
   `sdkReleaseStrandedGate`. A gate whose turn's stream has been **completely
   silent** past `GATE_SILENCE_RELEASE_MS` is force-released so the queue drains.
   Non-destructive: it does not kill the turn or touch the transcript, it just
   lets the generator proceed — the same thing a normal turn end does.
2. **Watchdog** — `decideSessionRecycle` + `src/main/session-watchdog.ts`.
   Consumes **#88's** `decideQueueStall` verdict (no second detector), and when a
   workspace with parked work has not started a turn, stops the session and
   re-wakes it on the **same** `sdkSessionId`, re-delivering parked messages
   through `releaseInboxBlock` (which removes a block only on a confirmed
   `'started'`). Anti-flap: `MAX_RECYCLES_PER_HOUR`, and exceedance is **logged
   at error level, never silent**.

### Why the bound is on PROGRESS, not duration

`session.lastStreamAt` is refreshed by **every** message on the SDK stream. A turn
may run for hours; it is only ever released after emitting *nothing at all* for
the window. A duration bound cannot distinguish a dead turn from a slow-but-live
one — that is the issue-#62 mistake, which shipped a fixed flush bound and made a
live reader truncate at the byte-identical length of the original bug. The
`busy_backdated` rig arm exists to hold this property: it backdates the stamp and
then lets the turn keep emitting, so it fails the instant the stamp stops being
written (verified — see the mutation table).

## Measurements and their provenance

| Figure | Status |
|---|---|
| `GATE_SILENCE_RELEASE_MS = 10min` | **UNBASELINED.** The distribution of longest-silence-within-a-live-turn across a real fleet is not measured. Chosen as a conservative floor; safety does not rest on it, because releasing the gate is non-destructive and loses no message. |
| `MAX_RECYCLES_PER_HOUR = 3` | **UNBASELINED as a rate.** Justified as a ceiling: both field occurrences were single events ≤35 min apart, so 3/hour is far above observed need while converging quickly on "tell a human". |
| `QUEUE_STALL_THRESHOLD_MS = 15min` | Inherited from #88, whose own comment records it as unbaselined. Safe because a `running` workspace is never stalled, so a long turn cannot trip it at any N. |

## Rig results (2026-08-26, `scripts/e2e-session-wedge.sh`)

```
control_healthy  outcome=started  consumedSecondTurn=true   gateHeldBefore=false
wedged           outcome=timeout  consumedSecondTurn=false  gateHeldBefore=true
control_busy     outcome=timeout  gateReleased=false
busy_backdated   outcome=timeout  gateReleased=false
recovered        outcome=started  consumedSecondTurn=true   gateReleased=true
```

`control_healthy` is the instrument audit: without it, every `started:false`
would be indistinguishable from a dead rig.

## Mutation results (one mutant per arm, each verified live in the file)

| Mutant | Arm | Result |
|---|---|---|
| `sdkReleaseStrandedGate` → no-op | `recovered` | **KILLED** — `ok:false`, `consumedSecondTurn:false` |
| per-message `lastStreamAt` stamp deleted | `busy_backdated` | **KILLED** — wrongly releases a LIVE turn (`gateReleased:true`) |
| per-message stamp deleted | `control_busy` | **SURVIVED** — recorded, and it is *why* `busy_backdated` exists: `control_busy` is never backdated, so it is refused on the wall-clock bound whether or not the stamp is written. A right verdict for the wrong reason. |

Unit-level mutants on the pure policy (`src/shared/session-wedge.test.ts`, 16
cases): dropping the reused-gate-slot guard, the progress bound, the anti-flap
limit, the `sessionLive` guard, and the rolling window each fail ≥1 case.

## The false-positive fixture (ledger #89, verbatim)

`parked=2, status=idle, session alive, age 46s → MUST NOT TRIGGER`. Real: five
busy agents parked deliveries during one broadcast and two read `idle` while
provably working. Asserted end-to-end through the **real** `decideQueueStall`
(not a hand-made verdict object) in `session-wedge.test.ts`, alongside a
`running`-with-parked-work arm and a positive control that MUST recycle.
