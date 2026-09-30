#!/usr/bin/env bash
# C2 #209 — regenerate EVERY measured number of docs/research/hidden-cost-inventory.md, in order, into $EV (evidence dir).
# D7: each step waits for a calm host (load < 19 AND MemAvailable > 6 GB, else waits up to 20 min, else SKIPS and says so) — a
# timing-sensitive number taken on a loaded host is VOID. Never loop this. ~60 min end to end on a calm host.
#   pnpm run build:bundles && bash scripts/hidden-cost/run-all.sh [step...]
#   steps: enum scenarios app git loopscan cli npx hooks proc scaling c1 field   (default: all)
# Afterwards:  python3 scripts/hidden-cost/render-tables.py $EV > $EV/tables.md ; python3 scripts/hidden-cost/derive.py > $EV/derived.txt
set -u
cd "$(dirname "$0")/../.."
export EV="${EV:-docs/research/hidden-cost-inventory/evidence}"; mkdir -p "$EV"
STEPS="${*:-enum scenarios app git loopscan cli npx hooks proc scaling c1 field}"
LOG="$EV/RUN-LOG.txt"; : >> "$LOG"
say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
calm() {
  for _ in $(seq 240); do
    l=$(cut -d' ' -f1 /proc/loadavg); m=$(awk '/MemAvailable/ {print int($2/1024/1024)}' /proc/meminfo)
    if awk -v l="$l" 'BEGIN{exit !(l<19)}' && [ "$m" -ge 6 ]; then return 0; fi
    sleep 5
  done
  say "SKIP: host never calmed (load=$l avail=${m}GB) — step VOID"; return 1
}
has() { case " $STEPS " in *" $1 "*) return 0;; esac; return 1; }
say "run-all start: HEAD=$(git rev-parse --short HEAD) pkg=$(node -p "require('./package.json').version") claude=$(claude --version 2>&1 | head -1) node=$(node --version) kernel=$(uname -r) pagesize=$(getconf PAGESIZE) nproc=$(nproc)"
if has enum; then say "enumeration"; bash scripts/hidden-cost/enumerate.sh > "$EV/enumeration-counts.txt"; for c in sdk-control sdk-query proc-spawn proc-exec pty net-fetch net-http net-updater timer-interval timer-timeout watch raf css-infinite npx git-net gh-cli resource-read hook-script simple-git shell-env; do bash scripts/hidden-cost/enumerate.sh --list $c > "$EV/enumeration-$c.txt"; done; fi
if has scenarios; then calm && { say "scenarios"; OUT="$EV" bash scripts/hidden-cost/run-scenarios.sh >> "$LOG" 2>&1; }; fi
if has app; then bash scripts/hidden-cost/run-app-arms.sh idle8 ws24 hid8 run8 focus8 sess4 fg1 bg1 res8; fi
if has git; then calm && for repo in "$HOME/dev/metarepo" "$HOME/Applications/orchestra"; do say "git-poll-cost $repo"; bash scripts/hidden-cost/git-poll-cost.sh "$repo" 20 | tee -a "$LOG" > "$EV/git-poll-cost-$(basename "$repo").txt"; done; fi
if has loopscan; then calm && { say "loop-scan-cost"; HC_OUT="$EV/loop-scan-cost.json" bash scripts/hidden-cost/loop-scan-cost.sh --ws 32 --runs 5 >> "$LOG" 2>&1; }; fi
if has cli; then calm && { say "cli-cost help / whoami"; bash scripts/hidden-cost/cli-cost.sh 10 help | tee -a "$LOG" > "$EV/cli-cost-help.txt"; bash scripts/hidden-cost/cli-cost.sh 10 whoami | tee -a "$LOG" > "$EV/cli-cost-whoami.txt"; }; fi
if has npx; then calm && { say "npx-mcp-cost"; bash scripts/hidden-cost/npx-mcp-cost.sh 5 | tee -a "$LOG" > "$EV/npx-mcp-cost.txt"; }; fi
if has hooks; then calm && { say "hook-cost"; bash scripts/hidden-cost/hook-cost.sh --runs 12 --peers 12 --with-orchestra-cli 0 > "$EV/hook-cost.json" 2>>"$LOG"; }; fi
if has proc; then calm && { say "proc-table-cost"; bash scripts/hidden-cost/proc-table-cost.sh > "$EV/proc-table-cost.json" 2>>"$LOG"; }; fi
if has scaling; then calm && { say "turn-end-scaling"; node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/hidden-cost/turn-end-scaling.mjs 2>&1 | tee -a "$LOG" > "$EV/turn-end-scaling.txt"; }; fi
if has c1; then calm && { say "C1 production-parity normal arm"; node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/session-budget/run.mjs --arm normal --json > "$EV/c1-normal-arm.json" 2>>"$LOG"; }; fi
if has field; then say "field notes + census + live watcher"; python3 scripts/hidden-cost/field-notes.py | tee -a "$LOG" > "$EV/field-notes.txt"; node scripts/hidden-cost/fleet-census.mjs | tee -a "$LOG" > "$EV/field-census.txt"; python3 scripts/hidden-cost/live-children-watch.py 90 --detail | tee -a "$LOG" > "$EV/field-live-children-90s.txt"; fi
say "run-all done"
