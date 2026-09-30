#!/usr/bin/env bash
# C2 #209 — the whole-app rig arms, each retried (max 3 attempts) when it comes back VOID with a renderer CDP stall
# ("cdp timeout Runtime.evaluate": measured in 4 of ~14 boots, at random points — the renderer stops answering, so nothing after
# it is a measurement). A VOID attempt is kept as evidence/discarded/<label>-attemptN.json, never reported.
#   EV=docs/research/hidden-cost-inventory/evidence bash scripts/hidden-cost/run-app-arms.sh [label...]
set -u
cd "$(dirname "$0")/../.."
EV="${EV:-docs/research/hidden-cost-inventory/evidence}"; mkdir -p "$EV/discarded"
LOG="$EV/RUN-LOG.txt"
say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
calm() { for _ in $(seq 240); do l=$(cut -d' ' -f1 /proc/loadavg); m=$(awk '/MemAvailable/ {print int($2/1024/1024)}' /proc/meminfo); awk -v l="$l" 'BEGIN{exit !(l<19)}' && [ "$m" -ge 6 ] && return 0; sleep 5; done; say "SKIP: host never calmed (load=$l avail=${m}GB)"; return 1; }
declare -A SPEC=(
  [idle8]="--ws 8 --fake-net 1 --warm 30 --measure 300"
  [ws24]="--ws 24 --warm 30 --measure 180"
  [vis8]="--ws 8 --running 8 --hidden 90 --warm 20 --measure 120"
  [hid8]="--ws 8 --hidden 90 --warm 20 --measure 90"     # window moved to the sway scratchpad (sway get_tree visible=false proven); polls still running?
  [run8]="--ws 8 --running 8 --warm 20 --measure 90"     # 8 sidebar rows driven to `running` through the real events spool
  [focus8]="--ws 8 --focus-cycles 5 --warm 20 --measure 90"
  [sess4]="--ws 8 --sessions 4 --stream 600 --rate 60 --warm 20 --measure 90"
  [fg1]="--ws 8 --sessions 1 --stream-on 0 --stream 1200 --rate 60 --warm 20 --measure 60"   # 1 streaming session in the ACTIVE (mounted) pane
  [bg1]="--ws 8 --sessions 1 --stream-on 3 --stream 1200 --rate 60 --warm 20 --measure 60"   # the same stream in a BACKGROUND workspace (pane not mounted)
  [res8]="--ws 8 --resources-page 60 --warm 20 --measure 60"                                   # Resources page (2 s sampler + 30 s size scan) then Bus page (2 s poll)
)
ORDER="${*:-idle8 ws24 vis8 focus8 sess4 fg1 bg1 res8}"
for label in $ORDER; do
  for attempt in 1 2 3; do
    calm || break
    say "app rig $label attempt $attempt: ${SPEC[$label]}"
    out=$(bash scripts/hidden-cost/app-idle-rig.sh ${SPEC[$label]} --label "$label" 2>"$EV/app-$label.stderr"); rc=$?
    echo "$out" >> "$LOG"; say "  rc=$rc"
    d=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read().strip().splitlines()[-1])["out"])' 2>/dev/null)
    [ -n "$d" ] && [ -f "$d/result.json" ] || continue
    if [ "$rc" = 0 ]; then
      cp "$d/result.json" "$EV/app-$label.json"; cp "$d/execlog.txt" "$EV/app-$label.execlog.txt"; [ -f "$d/gh-calls.log" ] && cp "$d/gh-calls.log" "$EV/app-$label.gh-calls.log"
      break
    fi
    cp "$d/result.json" "$EV/discarded/$label-attempt$attempt.json"; say "  VOID attempt $attempt kept in evidence/discarded/"
  done
done
say "run-app-arms done"
