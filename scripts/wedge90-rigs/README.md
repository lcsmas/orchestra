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
