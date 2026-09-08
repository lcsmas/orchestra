# #116 re-gate ledger — what carries, what does NOT
Taken on tip 835eb757ecd00bc7dcc8b9e01808b182687ac637 (verifier ws c76061ed)
Authority: OPS-B 18a2d373, ledger #123. Written BEFORE the re-gate so it cannot be rationalised after.

## CARRIED FORWARD (do not re-run unless the F1-F5 diff touches the named file)
| Gate | Result | Guard: re-run if diff touches |
|---|---|---|
| C11 migration chain | RC 0 — from v1 built from SHIPPED b88c846 SQL -> v2, mirror_records present, no shipped migration edited | src/main/bus.ts MIGRATIONS / SCHEMA_VERSION |
| C12 native usable | RC 0 — sqlite_version 3.49.2, construct+read-back+reopen | package.json deps, bus-binding.ts |
| C1 typecheck | RC 0, 0 diagnostics | ANY .ts change -> ALWAYS re-run (cheap) |
| C6a fixtures | RC 0 | scripts/fixtures/**, src/shared/context-usage.ts |
| T116.2 (delivery survives destroyed bus) | RC 0 — outcome still 'live', byte-identical to healthy arm | bus-mirror.ts try/catch |
| T116.3 (three distinct outcomes) | RC 0 — live/inbox/withdrawn driven not seeded | shared/bus-mirror.ts outcomeFor() |
| Seam audit workspaces.ts | 2 hunks (55, 2777), 0 deletions, notice region at 3257 -> no #118 overlap | src/main/workspaces.ts |

## EXPLICITLY NOT CARRIED (OPS-B caution — re-derive from scratch)
- **T116.1** — F1's fix CHANGES what it must assert: 0 message rows per REFUSAL shape,
  plus a DELIVERED send in the SAME COMMAND as the positive control (a 0 that cannot
  distinguish "refused correctly" from "mirror dead" is the C4-shaped vacuity).
- **T116.4** — F4's fix changes the INSERT PATH that both T116.1 and T116.4 read.
- **C2 unit suite** — always re-run; baseline was 1389/0/0 on 835eb757 (master baseline 1365).
- **F2 mutant** — MANDATORY re-run against the fixed tree. Binding rule:
  A SOURCE-TEXT ASSERTION IS NOT AN EXECUTION.
  Mutant: `throw new Error('VB-F2-MUTANT: ...')` as the FIRST LINE of mirrorDispatch
  (src/main/bus-mirror.ts, pristine sha c5f5e279a7f52514dc48b3d2fc8de10ec10b99a1).
  Measured on 835eb757: pnpm run test -> RC 0, 1389 pass / 0 fail (BLIND)
                        /tmp/vb-rigs/t116-independent.mjs -> RC 1 (throw in the stack)
  **A suite still at 1389/0 under this mutant has NOT fixed F2.**
  Require: an arm calling the REAL function + its RED-on-mutant run in the nomination.

## STILL NOT VERIFIED on this candidate (owed regardless of carry-forward)
C3 build · C4/C5 packaged boot arms (incl. re-deriving the self-edited 'schema v2'
literal — a self-edited gate is the one to re-derive) · C6b cli-pipe via
scripts/e2e-contained-rig.sh · C7 · C8 · C9 map · C10 · T116.4 counters ·
the 'duplicate is structurally unreachable' CONSTRUCTION claim · lostWake cross-ticket
dep on #117 · C12 under Electron ABI 130.

## Standing rules in force
- Hard outer deadline (timeout N) on EVERY rig invocation.
- Re-fetch + checkout --detach FETCH_HEAD before every arm; a detached HEAD never follows a ref.
- Carry the C12 justification sentence verbatim in every report.
