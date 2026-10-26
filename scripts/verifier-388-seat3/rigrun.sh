#!/usr/bin/env bash
# rigrun.sh <name> <tree> <driver.mjs> <label> [driver args...]  — G10 + G10b snapshots around ONE contained-rig drive (seat 3, vague #388).
set -uo pipefail
[[ "${V3_FREEZE_LIFTED:-}" == 1 ]] || { echo "REFUSED: all-Electron freeze (ledger #405 Q2, OPS 9099) — export V3_FREEZE_LIFTED=1 only after OPS lifts it"; exit 99; }
NAME="$1"; TREE="$2"; DRV="$3"; LBL="$4"; shift 4
V="$TMPDIR/v3rig"; D="$V/runs"; mkdir -p "$D"
export E2E_RIG_BASE="/var/tmp/v388s3-$(id -u)"; mkdir -p -m 700 "$E2E_RIG_BASE"; mkdir -p -m 700 "$E2E_RIG_BASE/pin-cfg"
export CLAUDE_CONFIG_DIR_PIN="$E2E_RIG_BASE/pin-cfg"
avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"; (( avail_kb >= 6*1024*1024 )) || { echo "ABORT: MemAvailable ${avail_kb} kB < 6 GB"; exit 2; }
node "$V/g10.mjs" snap "$D/$NAME.g10.before" >/dev/null
cd "$TREE" || exit 90
nice -n 10 bash scripts/e2e-contained-rig.sh node "$DRV" "$TREE" "$LBL" "$@" > "$D/$NAME.log" 2>&1; RC=$?
node "$V/g10.mjs" snap "$D/$NAME.g10.after" >/dev/null
grep -E '^(FAIL|RIG-RESULT|REFUSED|ABORT|HARNESS-ERROR|INFO  (urlbar-tally|identity))' "$D/$NAME.log" | cut -c1-420
node "$V/g10.mjs" diff "$D/$NAME.g10.before" "$D/$NAME.g10.after" | cut -c1-300
echo "RIGRUN name=$NAME rc=$RC uptime=$(uptime | sed 's/.*load average: //')"
exit $RC
