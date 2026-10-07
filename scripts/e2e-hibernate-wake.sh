#!/usr/bin/env bash
# Runs every arm of e2e-hibernate-wake.mjs (#198 D14). REQUIRED arms must be ok:true
# (a missing/failed line fails). DEPENDENT arms are printed but never fail the run — empty
# now that #124 (wake_during_teardown) and the hibernating marker (hibernate_exit1) are in.
set -u
cd "$(dirname "$0")/.."
REQUIRED="window_4min window_6min recent_activity control_6h guard_run_pty guard_turn bg_task bg_task_done bg_task_healed level_only level_only_healed level_after_done wake_after fleet_unread_wake toplevel_unread teardown_chip fresh_record wake_during_teardown hibernate_exit1"
DEPENDENT=""
RC=0
run_arm() {
  timeout 90 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
    scripts/e2e-hibernate-wake.mjs "$1" 2>/dev/null | tail -1
}
for arm in $REQUIRED; do
  line=$(run_arm "$arm")
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "REQUIRED  $line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
for arm in $DEPENDENT; do
  line=$(run_arm "$arm")
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "DEPENDENT $line"
done
exit $RC
