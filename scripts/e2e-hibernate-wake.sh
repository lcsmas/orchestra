#!/usr/bin/env bash
# Runs every arm of e2e-hibernate-wake.mjs (#198 D14). REQUIRED arms must be ok:true
# (a missing/failed line fails). DEPENDENT arms are printed but never fail the run:
#   wake_during_teardown — needs #124's identity-guarded `sessions.delete` (red without it)
#   hibernate_exit1      — measurement of a known gap (hibernate stop classified as an error row)
# Promote a dependent arm to REQUIRED the commit its fix lands.
set -u
cd "$(dirname "$0")/.."
REQUIRED="window_4min window_6min recent_activity control_6h guard_run_pty guard_turn wake_after teardown_chip"
DEPENDENT="wake_during_teardown hibernate_exit1"
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
