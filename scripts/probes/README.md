# maxTurns probes (issues #69 / #85)

**These hit the live Anthropic API and cost money. They are not part of
`pnpm run test` and nothing runs them automatically.** Run one deliberately:

```sh
node scripts/probes/maxturns-probe3.mjs          # the positive control
MT=2 N=4 node scripts/probes/maxturns-probe1.mjs
ARM=B node scripts/probes/maxturns-probe4.mjs    # runaway arm (~5 min)
ARM=A node scripts/probes/maxturns-probe4.mjs    # coordinator arm (~9 min)
```

## Why these are committed

Three separate corrections to `docs/research/issue-69-maxturns-findings.md`
were caused by probes whose **shape** was wrong, not whose logic was — and each
time the probe itself had been thrown away, so the next person re-derived the
error instead of reading it. The specific trap: an async generator that
**terminates** produces a throw that Orchestra's real `promptStream`
(`src/main/agent-sdk.ts`, `for(;;)`, returns only on `session.stopping`) can
never produce. Two ledger-level wrong conclusions came from that alone.

Committing the scripts makes the *shape* reviewable. A prose "recipe" cannot
carry it — the #85 doc claimed its recipe was "fully specified" in prose, and
it was not: it omitted the turn-gate wiring and the exact prompts, which are
the two things that decide whether the cap binds at all.

## What each probe settles

| Probe | Question | Result (2026-08-25, SDK 0.3.241, haiku-4.5) |
|---|---|---|
| 1 | Does a 2nd `error_max_turns` throw / starve the queue? | No — 4/4 consumed, `threw=null` |
| 2 | Does `num_turns` accumulate at `maxTurns:200`? | No — `num_turns=3` six times, flat |
| 3 | **Positive control for 2** | Cap 5 vs cumulative need 12 → 4/4 success |
| 4 | `ARM=A` coordinator / `ARM=B` runaway | A: 280 consumed turns, alive. B: runaway stopped at 201 |

**Probe 3 is the load-bearing one.** Probe 2 alone is an unaudited null:
`num_turns=3` six times is equally consistent with "the counter resets" and
"the cap never came near binding". Probe 3 picks a cap that could **only** bind
if the counter were cumulative, and nothing exhausts. That is what refutes
#85's premise; without it there is no measurement, only a comfortable number.

## Design constraints — break these and the probe lies

1. **`for(;;)` generator, turn-gated.** A terminating generator fabricates a
   throw. This is correction #3 in the findings doc.
2. **Prompts must REQUIRE more round-trips than the cap.** A 1-round-trip
   prompt under `maxTurns:1` returns clean successes — a comfortable false
   negative. Probes 1/3 force 2–3 dependent `Bash` calls for this reason.
3. **A control that could only pass one way.** See probe 3.
4. **Print the precondition beside the result.** Probe 4 prints the cap under
   test; a drifting precondition passes silently in the flattering direction.

Rebuilt at `/tmp/t85probe/` during wave-8; moved here because a rig that lives
only in `/tmp` dies with the workspace and takes the evidence with it.
