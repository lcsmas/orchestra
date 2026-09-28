#!/usr/bin/env bash
# Runs every arm of e2e-inbox-redrive.mjs (#124 S4); a missing/failed line fails.
set -u
cd "$(dirname "$0")/.."
REDRIVE_HOME="${REDRIVE_HOME:-/tmp/inbox-redrive-124}"
case "$(realpath -m -- "$REDRIVE_HOME")" in /tmp/inbox-redrive-*|*/.tmp-redrive*) rm -rf -- "$REDRIVE_HOME" ;; *) echo "refusing REDRIVE_HOME=$REDRIVE_HOME" >&2; exit 2 ;; esac
export REDRIVE_HOME
RC=0
for arm in redrive redrive_two control_noresult; do
  line=$(timeout 90 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-inbox-redrive.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
exit $RC
