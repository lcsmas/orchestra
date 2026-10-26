#!/usr/bin/env bash
# g10wrap.sh <name> -- <cmd...>  — G10 (config/secret sha256) before/after — G10b REMOVED: no fleet read of the real bus (freeze, ledger #405 Q2) ONE rig command (seat 3).
set -uo pipefail
[[ "${V3_FREEZE_LIFTED:-}" == 1 ]] || { echo "REFUSED: all-Electron freeze (ledger #405 Q2, OPS 9099) — export V3_FREEZE_LIFTED=1 only after OPS lifts it"; exit 99; }
NAME="$1"; shift; [[ "$1" == "--" ]] && shift
V="$TMPDIR/v3rig"; D="$V/runs"; mkdir -p "$D"
avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"; (( avail_kb >= 6*1024*1024 )) || { echo "ABORT: MemAvailable ${avail_kb} kB < 6 GB"; exit 2; }
node "$V/g10.mjs" snap "$D/$NAME.g10.before" >/dev/null
"$@" > "$D/$NAME.log" 2>&1; RC=$?
node "$V/g10.mjs" snap "$D/$NAME.g10.after" >/dev/null
node "$V/g10.mjs" diff "$D/$NAME.g10.before" "$D/$NAME.g10.after" | cut -c1-320
echo "G10WRAP name=$NAME rc=$RC log=$D/$NAME.log uptime=$(uptime | sed 's/.*load average: //')"
exit $RC
