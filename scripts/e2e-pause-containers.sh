#!/usr/bin/env bash
# Runs every arm of e2e-pause-containers.mjs (#292) against the host's REAL dockerd. HEAVY: take the heavy-rig token first (ledger #295 D1.3).
# Missing/failed arm line = fail. SUBJECT_REPO / KEEPER_JS: see the .mjs header.
#   MUST_FAIL=1 → inverted: every arm marked mustFailOnMaster must come back NOT ok (SUBJECT_REPO = the PARENT tree, no container step).
set -u
cd "$(dirname "$0")/.."
if ! awk '/MemAvailable/{exit !($2 > 6*1048576)}' /proc/meminfo; then echo "MemAvailable <= 6 GB: not starting the heavy rig" >&2; exit 3; fi
ARMS=${ARMS:-"pause_and_reprise removed_by_hand docker_absent docker_refused autoremove_and_failed app_resolution_moved"}
RC=0
for arm in $ARMS; do
  line=$(timeout 600 node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-pause-containers.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  verdict=$(printf '%s' "$line" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.ok?"ok":"red")+" "+(j.mustFailOnMaster?"must":"may"))}catch{console.log("red may")}})')
  if [ "${MUST_FAIL:-0}" = 1 ]; then
    case "$verdict" in "ok must") RC=1 ;; esac
  else
    case "$verdict" in ok*) : ;; *) RC=1 ;; esac
  fi
done
exit $RC
