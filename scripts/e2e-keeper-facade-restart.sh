#!/usr/bin/env bash
# Runs every arm of e2e-keeper-facade-restart.mjs (#124 S1 facade decision); a missing/failed line fails.
set -u
cd "$(dirname "$0")/.."
FACADE_HOME="${FACADE_HOME:-/tmp/keeper-facade-124}"
case "$(realpath -m -- "$FACADE_HOME")" in /tmp/keeper-facade-*|*/.tmp-facade*) rm -rf -- "$FACADE_HOME" ;; *) echo "refusing FACADE_HOME=$FACADE_HOME" >&2; exit 2 ;; esac
export FACADE_HOME
RC=0
for arm in facade_refuses_dying facade_attaches_live; do
  line=$(timeout 120 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-keeper-facade-restart.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
exit $RC
