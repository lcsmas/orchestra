# reviewer-a2-reaper — probes for A2 candidate `keeper-lifecycle-a2` @ c4eb6111 (ledger #224)

Every probe spawns ITS OWN fake keepers under `~/a2r-attack/arms/*` (HOME/ORCHESTRA_HOME = scratch) and filters every
signal to pids in its own spawned trees. Run: `node --experimental-strip-types --import <repo>/scripts/.r2-register.mjs <probe> <arm>`
(tree = detached worktree of the candidate, `pnpm install --offline`, `vite build --config vite.keeper.config.ts`).

| file | question | outputs/ |
|---|---|---|
| probe-wrapper.mjs direct\|wrapper\|dup | sole keeper launched through a fork-style wrapper (`timeout 300 node keeper.js …`) — killed by the reaper? | wrapper-*.json |
| probe-r2.mjs | tracked keeper's pid recycled by a non-keeper at kill time — clean tree signals nothing; R2 mutant signals the sole live keeper | r2-clean.json, r2-mutant.json |
| probe-hungkill.mjs normal\|hung | `killKeeper` on a SIGSTOPped keeper — CLI child orphaned? | hungkill-*.json |
| probe-hungprobe.mjs | live-but-hung K_old + 2nd daemon: refuse (clean) vs steal (K1 mutant bundle) | hungprobe-*.json |
| mutate.py <id> | in-place mutant (byte-exact backup + cmp restore, flock single-harness, clean-tree precondition) over the 3 suites that reach the clause | mut-results*.log |

First mutation run (`mut-results.log`): S1..R6 valid (one harness); R56/K1/K2 lines are VOID (a second harness overlapped
because a `ps|grep` read through the rtk filter returned nothing) — re-run alone in `mut-results-2.log`.
