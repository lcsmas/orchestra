# reviewer-a2-final probes (ledger #224, A2 final delta D1–D5/D7; candidate keeper-lifecycle-a2 @ e3983174)

All scripts hard-code `/home/lmas/...`: isolated HOME `/home/lmas/rf`, probe trees `/home/lmas/a2f-tip` (tip, clean), `/home/lmas/a2f-mut` (mutants, byte-exact restore via `git show e3983174:<path>` + cmp), `/home/lmas/a2f-master` (G1).
- `mut.py` + `runmut.sh` + `wrap.sh`: in-place mutants (R1 K4d, R2, R3, R4 unlink-by-path, R5, R11, R12a, K4a/K4b, M43, M44) run through the shipped wrapper + resource-monitor + keeper tests; `outputs/mutants-e3983174.txt` (control 89/0/0; R4/R5/R11/R12a survive).
- `p1.mjs verdict|widened|control` + `preload.cjs`: real shipped keeper.js, env-gated `--require` delay of the stale-verdict→rename (and rename→link-back) gap; a rig-installed live fresh claim must not be acquired over. Tip: not displaced; R4/M44: displaced. `p3.mjs leftover|killmid`: crash mid-rename-aside cannot wedge.
- `rig-p4.patch` (on top of scripts/e2e-keeper-lifecycle.mjs @ e3983174): arms `p4_delete_recycled_pid[_ctl]`, `p4t_killtree_recycled[_ctl]`, `p5_sweep_live_claim` — each passes on the tip and reddens R12a / R11 / R5; `_ctl` arms prove the detector can see a kill.
- `sweeper.mjs` + `flipper.mjs` (+`flipperB.mjs` control): dead-claim sweep vs a live-claim swap (18/3615 lost; controls 0).
- `group-kill.sh`, `wd-kill.sh`, `same-arm.sh`: D4 watchdog (group SIGTERM = 0 left; watchdog SIGKILLed = 1 SIGSTOPped keeper left; same-arm concurrency).
