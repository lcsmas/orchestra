# reviewer-a2-delta probes (ledger #224, A2 delta review; candidate 92f3394e → 3ae0b01a)

All scripts hard-code `/home/lmas/...` paths (isolated `HOME=/home/lmas/rd` so leftovers are attributable). Read outputs with `rtk proxy ps`.

- `probe.mjs` (run via `run-probe.sh <arm> [SUBJECT_REPO]`): arms `k4_bg_grandchild`, `k4_scope`, `k4_snapshot_race`, `l2_start_during_bg_stop`, `l5_bulk_throw`, `l1_stale_claim`, `l1_fresh_control` (N/R/W env). Derived from `scripts/e2e-keeper-lifecycle.mjs` prelude.
- `mutate.py` / `mutate-probe.py`: in-place mutants (byte-exact backup + `cmp`) — K4a/K4b/K4d, L1a-d; results `outputs/mutants-92f3394e.log`.
- `leak-kill-rig.sh`, `timeout-emulation.sh`, `group-kill.sh`: abnormal-termination leak probes. `g1-master.sh`: G1 spot-check on a master worktree. `run-tests.sh` + `sampler.sh`: A2 test files under an isolated HOME + peak/final process count.
