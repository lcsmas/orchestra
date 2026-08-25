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

| rig | arms | what it pins |
|---|---|---|
| `false-positive.mjs` | `running` `idle` `waiting` | A busy, still-emitting session must NEVER be recycled — whatever `status` says. |
| `redelivery.mjs` | `live` `nohook` | Every parked block reaches the agent **exactly once**. |
| `flap-budget.mjs` | (none) | The anti-flap budget's shape, and whether the stand-down is surfaced. |

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
