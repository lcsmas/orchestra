#!/usr/bin/env bash
# Runs every arm of e2e-keeper-stop-semantics.mjs (#124 S2+S3); a missing/failed line fails.
set -u
cd "$(dirname "$0")/.."
STOPSEM_HOME="${STOPSEM_HOME:-/tmp/keeper-stop-semantics-124}"
case "$(realpath -m -- "$STOPSEM_HOME")" in /tmp/keeper-stop-semantics-*|*/.tmp-stopsem*) rm -rf -- "$STOPSEM_HOME" ;; *) echo "refusing STOPSEM_HOME=$STOPSEM_HOME" >&2; exit 2 ;; esac
export STOPSEM_HOME
RC=0
for arm in s3_noresult_kills s3_result_no_kill s2_teardown_only_self s2_sdkstop_only_self s1_stopped_label s1_crash_still_errors; do
  line=$(timeout 90 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-keeper-stop-semantics.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
exit $RC
