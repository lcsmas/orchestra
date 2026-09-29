Reviewer probes for A2 (candidate keeper-lifecycle-a2 @c4eb6111). Not for merge.
Run: SUBJECT_REPO=<candidate tree> A2_HOME=/home/lmas/rp/x node --experimental-strip-types --import <tree>/scripts/.r2-register.mjs probe.mjs <arm>
Arms: churn2 churn3 sync6 stopped_keeper kill_stopped prune_timing_fast prune_timing_sigterm_ignored delete_inflight_start unlink_fallback_pidless keeper_log_survives_stop stale_two_launch fresh_two_launch(control) bulk_window
probe.mjs = build-probe.mjs output (rig head) + tail arms. mutate.sh = byte-exact backup/cmp-restore mutation harness (keeper daemon).
