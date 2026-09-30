#!/bin/bash
# usage: wrap.sh <tree> <logfile> — the shipped wrapper + the 2 unit files, isolated HOME, foreground; prints counts
export HOME=/home/lmas/rf TMPDIR=/home/lmas/rf/tmp CLAUDE_CONFIG_DIR=/home/lmas/rf/claude-scratch
cd "$1" || exit 9
s=$(date +%s)
/usr/bin/node --test --experimental-strip-types src/main/keeper-lifecycle.test.ts src/shared/resource-monitor.test.ts src/keeper/keeper.test.ts > "$2" 2>&1
rc=$?
echo "END rc=$rc secs=$(( $(date +%s) - s ))" >> "$2"
