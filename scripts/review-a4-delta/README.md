# review-a4-delta — probes for liveness-hold-a4 @344c4a7d (NOT FOR MERGE)
Run from a worktree at the candidate tip, CLI built (`pnpm run build:cli`), `RV_W=$PWD`; scratch = /home/lmas/rv-a4d/scratch.
- `d7f7.test.ts` — D7 authorization + F7 fence matrix through the BUILT CLI on an isolated bus (prints rc + held/fence_events per row).
- `attack-delta.test.ts`, `ctl-delta.test.ts` — first reviewer's A1–A10/M4 probes (reviewer-a4 @ddc906cb) ported to the 4-arg `setRunHold`.
- `race-parent2.mts <startV> <iters> <N>` — concurrent first-open migration race (F5); positive control = remove the in-txn re-read.
- `mut.sh` — in-place mutant harness (byte-exact backup + `cmp` restore), runs the 8 touched suites.
