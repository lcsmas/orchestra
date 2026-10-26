#!/usr/bin/env bash
# urlbar-series.sh <N> <candTree> <baseTree> [prefix|full] — seat 1's bp-drive (prefix = through the first-navigation clause), cand/base INTERLEAVED, tally the URL-bar clause.
set -uo pipefail
[[ "${V3_FREEZE_LIFTED:-}" == 1 ]] || { echo "REFUSED: all-Electron freeze (ledger #405 Q2, OPS 9099) — export V3_FREEZE_LIFTED=1 only after OPS lifts it"; exit 99; }
N="$1"; CAND="$2"; BASE="$3"; MODE="${4:-prefix}"
V="$TMPDIR/v3rig"; D="$V/runs/urlbar"; mkdir -p "$D"
export E2E_RIG_BASE="/var/tmp/v388s3-$(id -u)"; mkdir -p -m 700 "$E2E_RIG_BASE/pin-cfg"; export CLAUDE_CONFIG_DIR_PIN="$E2E_RIG_BASE/pin-cfg"
DRV="$V/bp-prefix.mjs"; [[ "$MODE" == full ]] && DRV="$V/bp-drive.mjs"
node "$V/g10.mjs" snap "$D/series.g10.before" >/dev/null
tally() { # file -> ok|empty|fail|noresult
  local f="$1"
  if grep -q '^PASS  navigate/urlbar-shows-committed-url' "$f"; then echo ok
  elif grep -q 'KNOWN-BASELINE-DEFECT' "$f"; then echo empty
  elif grep -q '^FAIL  navigate/urlbar-shows-committed-url' "$f"; then echo fail
  else echo noresult; fi
}
for i in $(seq 1 "$N"); do
  for arm in cand base; do
    TREE="$CAND"; [[ $arm == base ]] && TREE="$BASE"
    avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"; (( avail_kb >= 6*1024*1024 )) || { echo "ABORT: low memory"; exit 2; }
    f="$D/$MODE-$arm-$i.log"
    (cd "$TREE" && nice -n 10 bash scripts/e2e-contained-rig.sh node "$DRV" "$TREE" "$arm-$i" $([[ "$MODE" == prefix ]] && echo prefix) > "$f" 2>&1)
    echo "run $i $arm: urlbar=$(tally "$f") | $(grep -E '^RIG-RESULT' "$f" | sed -E 's/ home=.*//') | load=$(uptime | sed 's/.*load average: //;s/,.*//')"
  done
done
node "$V/g10.mjs" snap "$D/series.g10.after" >/dev/null
node "$V/g10.mjs" diff "$D/series.g10.before" "$D/series.g10.after" | cut -c1-300
for arm in cand base; do echo "TALLY $arm: ok=$(for f in "$D/$MODE-$arm"-*.log; do tally "$f"; done | grep -c '^ok$') empty=$(for f in "$D/$MODE-$arm"-*.log; do tally "$f"; done | grep -c '^empty$') fail=$(for f in "$D/$MODE-$arm"-*.log; do tally "$f"; done | grep -c '^fail$') noresult=$(for f in "$D/$MODE-$arm"-*.log; do tally "$f"; done | grep -c '^noresult$') of $N"; done
