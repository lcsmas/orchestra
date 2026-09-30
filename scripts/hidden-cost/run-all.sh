#!/usr/bin/env bash
# C2 #209 — regenerate EVERY measured number of docs/research/hidden-cost-inventory.md, in order, into $EV (evidence dir).
# D7: each step waits for a calm host (load < 19 AND MemAvailable > 6 GB, else waits up to 20 min, else SKIPS and says so) —
# a timing-sensitive number taken on a loaded host is VOID. Never loop this. ~45 min end to end.
#   bash scripts/hidden-cost/run-all.sh [step...]      steps: scenarios app git loopscan cli npx hooks field
set -u
cd "$(dirname "$0")/../.."
EV="${EV:-docs/research/hidden-cost-inventory/evidence}"; mkdir -p "$EV"
STEPS="${*:-scenarios app git loopscan cli npx hooks field}"
LOG="$EV/RUN-LOG.txt"; : >> "$LOG"
say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
calm() {  # wait until load < 18 and >= 6 GB available; 20 min cap
  for _ in $(seq 240); do
    l=$(cut -d' ' -f1 /proc/loadavg); m=$(awk '/MemAvailable/ {print int($2/1024/1024)}' /proc/meminfo)
    if awk -v l="$l" 'BEGIN{exit !(l<19)}' && [ "$m" -ge 6 ]; then return 0; fi
    sleep 5
  done
  say "SKIP: host never calmed (load=$l avail=${m}GB) — step VOID"; return 1
}
has() { case " $STEPS " in *" $1 "*) return 0;; esac; return 1; }
say "run-all start: HEAD=$(git rev-parse --short HEAD) claude=$(claude --version 2>&1 | head -1) node=$(node --version) kernel=$(uname -r) pagesize=$(getconf PAGESIZE) nproc=$(nproc)"
if has scenarios; then calm && { say "scenarios"; OUT="$EV" bash scripts/hidden-cost/run-scenarios.sh >> "$LOG" 2>&1; }; fi
if has app; then
  for spec in "idle8|--ws 8 --fake-net 1 --warm 30 --measure 300" "ws24|--ws 24 --warm 30 --measure 180" \
              "ws8focus|--ws 8 --focus-cycles 5 --running 8 --hidden 90 --warm 20 --measure 120" \
              "sess4|--ws 8 --sessions 4 --stream 600 --rate 60 --warm 20 --measure 90"; do
    label="${spec%%|*}"; args="${spec#*|}"
    calm || continue
    say "app rig $label: $args"
    out=$(bash scripts/hidden-cost/app-idle-rig.sh $args --label "$label" 2>"$EV/app-$label.stderr"); rc=$?
    echo "$out" >> "$LOG"; say "  rc=$rc"
    d=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read().strip().splitlines()[-1])["out"])' 2>/dev/null)
    [ -n "$d" ] && [ -f "$d/result.json" ] && cp "$d/result.json" "$EV/app-$label.json" && cp "$d/execlog.txt" "$EV/app-$label.execlog.txt" 2>/dev/null && [ -f "$d/gh-calls.log" ] && cp "$d/gh-calls.log" "$EV/app-$label.gh-calls.log"
  done
fi
if has git; then
  calm && for repo in "$HOME/dev/metarepo" "$HOME/Applications/orchestra"; do say "git-poll-cost $repo"; bash scripts/hidden-cost/git-poll-cost.sh "$repo" 20 | tee -a "$LOG" > "$EV/git-poll-cost-$(basename "$repo").txt"; done
fi
if has loopscan; then calm && { say "loop-scan-cost"; HC_OUT="$EV/loop-scan-cost.json" bash scripts/hidden-cost/loop-scan-cost.sh --ws 32 --runs 5 >> "$LOG" 2>&1; }; fi
if has cli; then calm && { say "cli-cost help / whoami"; bash scripts/hidden-cost/cli-cost.sh 10 help | tee -a "$LOG" > "$EV/cli-cost-help.txt"; bash scripts/hidden-cost/cli-cost.sh 10 whoami | tee -a "$LOG" > "$EV/cli-cost-whoami.txt"; }; fi
if has npx; then calm && { say "npx-mcp-cost"; bash scripts/hidden-cost/npx-mcp-cost.sh 5 | tee -a "$LOG" > "$EV/npx-mcp-cost.txt"; }; fi
if has hooks; then calm && { say "hook-cost"; bash scripts/hidden-cost/hook-cost.sh --runs 12 --peers 12 --with-orchestra-cli 0 > "$EV/hook-cost.json" 2>>"$LOG"; }; fi
if has field; then say "field census + live watcher"; node scripts/hidden-cost/fleet-census.mjs | tee -a "$LOG" > "$EV/field-census.txt"; python3 scripts/hidden-cost/live-children-watch.py 90 --detail | tee -a "$LOG" > "$EV/field-live-children-90s.txt"; fi
say "run-all done"
