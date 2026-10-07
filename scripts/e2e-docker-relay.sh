#!/usr/bin/env bash
# Runs every arm of e2e-docker-relay.mjs (#291) against the host's REAL dockerd. HEAVY: take the heavy-rig token first
# (ledger #295 D1.3). Missing/failed arm line = fail. SUBJECT_REPO / KEEPER_JS: see the .mjs header.
#   MUST_FAIL=1 → inverted: every arm marked mustFailOnMaster must come back NOT ok (run against origin/master's keeper).
set -u
cd "$(dirname "$0")/.."
if ! awk '/MemAvailable/{exit !($2 > 6*1048576)}' /proc/meminfo; then echo "MemAvailable <= 6 GB: not starting the heavy rig" >&2; exit 3; fi
ARMS=${ARMS:-"run_labels compose_labels user_labels streams kill_relay no_relay_fallback switch_off app_switch sweep_relay_files"}
RC=0
for arm in $ARMS; do
  line=$(timeout 600 node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-docker-relay.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  if [ "${MUST_FAIL:-0}" = 1 ]; then
    case "$line" in *'"mustFailOnMaster":true'*) case "$line" in *'"ok":false'*) : ;; *) RC=1 ;; esac ;; esac
  else
    case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
  fi
done
exit $RC
