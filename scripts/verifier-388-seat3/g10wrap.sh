#!/usr/bin/env bash
# g10wrap.sh <name> -- <cmd...>  — G10 (config/secret sha256) + G10b (login-collection listing) before/after ONE rig command (seat 3).
set -uo pipefail
NAME="$1"; shift; [[ "$1" == "--" ]] && shift
V="$TMPDIR/v3rig"; D="$V/runs"; mkdir -p "$D"
avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"; (( avail_kb >= 6*1024*1024 )) || { echo "ABORT: MemAvailable ${avail_kb} kB < 6 GB"; exit 2; }
node "$V/g10.mjs" snap "$D/$NAME.g10.before" >/dev/null; node "$V/g10b.mjs" snap "$D/$NAME.g10b.before" >/dev/null
"$@" > "$D/$NAME.log" 2>&1; RC=$?
node "$V/g10.mjs" snap "$D/$NAME.g10.after" >/dev/null; node "$V/g10b.mjs" snap "$D/$NAME.g10b.after" >/dev/null
node "$V/g10.mjs" diff "$D/$NAME.g10.before" "$D/$NAME.g10.after" | cut -c1-320; node "$V/g10b.mjs" diff "$D/$NAME.g10b.before" "$D/$NAME.g10b.after" "$NAME"
echo "G10WRAP name=$NAME rc=$RC log=$D/$NAME.log uptime=$(uptime | sed 's/.*load average: //')"
exit $RC
