#!/usr/bin/env bash
# Runs every arm of e2e-context-seed-176.mjs (#176); a missing/failed line fails.
set -u
cd "$(dirname "$0")/.."
CS_HOME="${CS_HOME:-/tmp/context-seed-176-home}"
case "$(realpath -m -- "$CS_HOME")" in /tmp/context-seed-176-*) rm -rf -- "$CS_HOME" ;; *) echo "refusing CS_HOME=$CS_HOME" >&2; exit 2 ;; esac
export CS_HOME
RC=0
for arm in boot turn-end; do
  line=$(timeout 90 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-context-seed-176.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
exit $RC
