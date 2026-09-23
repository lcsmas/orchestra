#!/usr/bin/env bash
# Runs every arm of e2e-hung-cli-teardown.mjs; a missing line is a failed arm.
set -u
cd "$(dirname "$0")/.."
HUNG_HOME="${HUNG_HOME:-/tmp/hung-cli-home}"
case "$(realpath -m -- "$HUNG_HOME")" in /tmp/hung-cli-*) rm -rf -- "$HUNG_HOME" ;; *) echo "refusing HUNG_HOME=$HUNG_HOME" >&2; exit 2 ;; esac
export HUNG_HOME
RC=0
for arm in stop_healthy stop_hung rewind_hung restart_busy restart_stalled; do
  line=$(timeout 90 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-hung-cli-teardown.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
exit $RC
