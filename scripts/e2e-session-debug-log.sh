#!/usr/bin/env bash
# Runs every arm of e2e-session-debug-log.mjs (#177 G3); a missing/failed line fails.
set -u
cd "$(dirname "$0")/.."
SDL_HOME="${SDL_HOME:-/tmp/session-debug-log-home}"
case "$(realpath -m -- "$SDL_HOME")" in /tmp/session-debug-log-*) rm -rf -- "$SDL_HOME" ;; *) echo "refusing SDL_HOME=$SDL_HOME" >&2; exit 2 ;; esac
export SDL_HOME
RC=0
for arm in appears rotates; do
  line=$(timeout 90 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-session-debug-log.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
exit $RC
