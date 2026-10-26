#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel)"; V="$TMPDIR/v1"; f=0
for i in $(seq 1 8); do node --no-warnings --experimental-strip-types "$V/rig/probe-final.mjs" "$PWD" > "$V/repg-$i.out" 2>&1 || { f=$((f+1)); grep -E ' BAD ' "$V/repg-$i.out" | cut -c1-160; }; echo "repeat $i $(grep -E '^SUMMARY' $V/repg-$i.out)"; done
echo "UNMUTATED-REPEATS(8 + 2 controls below) fails=$f/8"
bash "$V/rig/run389f.sh"
