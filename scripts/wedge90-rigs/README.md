# Session-wedge behavioural rigs (issue #90, from review-90)

Three rigs that drive the **real** `src/main/session-watchdog.ts`
(`watchdogTick` / `recycleSession`), the real `inbox-tray.ts`, and the real
`agent-sdk.ts` `promptStream`/`consume` against a fake SDK injected through the
repo's own `__setQueryFactoryForTests` seam. They are **not** models.

They exist because review-90 found that **no test or rig in the repo executed
`session-watchdog.ts` at all** — and all three defects that review found were
invisible to the pure-function tests in `src/shared/session-wedge.test.ts` and
fell out of the first rig that drove the module itself.

## Running

Each rig runs in its OWN process (agent-sdk module state is global) and needs
the strip-types register shim, the same one `scripts/e2e-session-wedge.sh` uses:

```sh
node --experimental-strip-types --import ./scripts/.r2-register.mjs \
     scripts/wedge90-rigs/<rig>.mjs [arm]
```

An **empty line is a FAILED run, never a pass.**

**Run variants from INSIDE this directory, never from `/tmp`.** Each rig resolves
the repo root from its own path (`path.resolve(dirname(fileURLToPath(
import.meta.url)), '..', '..')`), so a copy placed elsewhere resolves to the
wrong root and dies with `ERR_INVALID_FILE_URL_HOST` /
`file://src/main/platform/index.ts` — which prints NOTHING on stdout and is
therefore indistinguishable from a failed arm. To try a variation, write it
beside the originals (e.g. `.tmp-<name>.mjs`, which is gitignored by the leading
dot only if you add it — just delete it after).

| rig | arms | what it pins |
|---|---|---|
| `false-positive.mjs` | `running` `idle` `waiting` | A busy, still-emitting session must NEVER be recycled — whatever `status` says. |
| `redelivery.mjs` | `live` `nohook` | Every parked block reaches the agent **exactly once**. |
| `flap-budget.mjs` | (none) | The anti-flap budget's shape, and whether the stand-down is surfaced. |
| `upstream-cause.mjs` | `reset` `refusal` `worker_exit` `reset_recovered` `control_result` | The #90 root-cause CLASS: which SDK message ends/abandons a turn WITHOUT a `type:'result'`, driven through the REAL `consume`/gate. Classifies each into WEDGE (stream stays open → gate stranded) vs SELF-RECOVER (stream ends → finally releases). Proves `conversation_reset` is the in-tree instance the #90 gate fix releases (revert the fix → `reset` reddens); `refusal` stays WEDGE (fix is scoped; layer-2 covers it). |

### `upstream-cause.mjs` — the root-cause investigation

The wedge is `consume()` releasing `session.turnGate` on exactly ONE message
type (`result`). The SDK contract (sdk.d.ts, `SDKResultMessage` jsdoc) is "the
CLI emits EXACTLY ONE result per turn" — so a wedge is a **contract violation**:
a turn abandoned without its `result`. This rig enumerates the SDK messages that
can abandon a turn and are NOT `result`, and asks of each: does it leave the
stream OPEN (WEDGE — the field signature: a live session whose control channel
still answers) or END it (SELF-RECOVER — `consume`'s finally releases)?

Two land as WEDGE: `conversation_reset` (a new conversation supersedes the
in-flight turn) and `model_refusal_no_fallback`. `conversation_reset` is the one
where a `result` provably can NEVER follow (it belongs to a defunct
conversation), so the #90 fix releases the gate on it directly. `refusal` is
normally still followed by a `result` in production, so it is left to the
cause-agnostic layer-2 watchdog — the rig keeps it as the standing proof that
the wedge is a CLASS, not a single message.

**The barrier trap this rig is built around.** A fake SDK iterator emits its
messages independently of the prompt generator, so the trigger message can race
the gate-arm and land BEFORE turn 1's gate is held — which reads as a wedge for
the wrong reason AND makes a gate-release mutant a no-op (the release fires when
nothing is held). The rig resolves `firstTurnSeen` the instant the drain loop
observes turn 1 and the iterator awaits it, so the trigger always lands on a
HELD gate. Verified: with the barrier, reverting the fix reddens `reset`; the
`[MUTANT] release branch fired ... gateHeld=true` ordering is the proof it now
reaches the gate.

## The two traps these rigs are built around

**1. `status` is not evidence of liveness.** `false-positive.mjs`'s `running`
arm must REFUSE and the `idle`/`waiting` arms must also refuse *while
`stallVerdict` still reads `STALLED`*. That last part is the point: if the
detector went dead, every arm would refuse and the rig would look green while
measuring nothing. Always read `stallVerdict` beside the verdict.

**2. A fix elsewhere can silently DISARM these rigs.** This is not theoretical —
it happened during review-90. When the progress guard landed in
`decideSessionRecycle`, `redelivery.mjs`'s subject (which emitted every 30ms)
started being refused *before* `recycleSession` was reached, so the arm printed
"nothing delivered, 0 duplicates" — indistinguishable from a pass, and actually
a probe that no longer touched the code under test. `flap-budget.mjs` went
vacuous the same way (`totalRecycles: 0`, which reads as "anti-flap works").

Both now **backdate `lastStreamAt`** so the recycle is genuinely entered, print
`PRE-TICK silentMs=` beside the verdict, and `flap-budget.mjs` carries an
explicit vacuity guard that refuses a verdict at 0 recycles. That guard is
mutation-verified: delete the backdate and it fires; restore it and it stays
silent.

**If you change the watchdog's trigger conditions, re-check these rigs still
REACH `recycleSession`** — a green arm here is only meaningful if the code path
ran.

## Results on `impl-session-wedge-90` (the implementer's tip, 2026-08-26)

Run by impl-session-wedge-90 after the R2-residual and R4 fixes landed. These
rigs are the ONLY probes that have ever caught these defects, so they are run
against the tip rather than trusted from a previous sha.

| rig / arm | result |
|---|---|
| `false-positive running` | `stallVerdict: not-stalled`, `RECYCLED_A_HEALTHY_BUSY_AGENT: false` |
| `false-positive idle` | **`stallVerdict: STALLED`**, still emitting (8), `RECYCLED…: false` |
| `false-positive waiting` | **`stallVerdict: STALLED`**, still emitting (8), `RECYCLED…: false` |
| `redelivery live` | each of 3 blocks delivered **exactly once**, `duplicated: []`, inbox empty |
| `redelivery nohook` | 1 delivered, 2 **left parked** (see below), `duplicated: []` |
| `flap-budget` | `totalRecycles: 3`, ticks 0/1/2 recycle then 3/4/5 stand down, surfaced only via `workspace:update` |

**The `idle`/`waiting` arms are the load-bearing ones**, and they are not
vacuous: `stallVerdict` reads `STALLED` — the detector was live and the
workspace *did* qualify — yet no recycle happened, because the session was still
emitting. That is R1's progress guard refusing on evidence rather than on
`status`, measured by an independent probe.

**`redelivery nohook` leaving 2 blocks parked is CORRECT, and was verified
rather than assumed.** Instrumenting the release loop showed block 1 returning
`{ok:true}` and block 2 returning `{ok:false, reason:'not-delivered'}`. Cause:
this arm's fake stream emits its results in the first ~60ms and is then SILENT
FOREVER, so by the second release there is no `result` to confirm a start.
Proof by measurement, not by argument — keeping the stream alive
(`n<40`, 120ms apart) and changing nothing else releases **all three, exactly
once, inbox empty**. A first hypothesis (too few results, `n<8`) was tried and
**refuted**: it changed nothing, because the issue is stream LIVENESS, not
count. Leaving blocks parked when a stream dies mid-recycle is the designed
failure mode: *the message stays where it was, never the message is gone.*

**`flap-budget` reproduces issue #97 on this tip** — the budget is spent in 3
consecutive minutes and the stand-down reaches no dedicated channel. The rig's
sensitivity was mutation-checked here too: deleting its `__backdateStreamForTests`
call drops it to `totalRecycles: 0`, i.e. the vacuous state the README warns
about, so the `3` above is a real measurement.

## Provenance

Written by review-90 against `impl-session-wedge-90`. Findings R1 (recycling a
busy healthy agent on `status=idle|waiting`) and R2 (parked block delivered
twice / stranded) were fixed at `545de4b`; the R2 **residual** (step 4's
`readInbox` snapshot is taken before the wake turn's hook finishes draining, so
one block is still delivered twice — 5/5 deterministic, `remainingInInbox:0`,
show-twice never lose) and R3 (whole budget spent in 3 consecutive minutes, then
57 minutes of stand-down surfaced only to `orchestra.log`) were open at that sha.
Full evidence: the two review-90 comments on issue #89.

These rigs are **behavioural probes, not a gate** — they are not wired into
`pnpm run test` and they assert by printing, not by exiting non-zero. Turning
the two arms that matter into real assertions is issue-#90 R4 follow-up work.
