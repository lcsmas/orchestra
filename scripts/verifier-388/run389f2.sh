#!/usr/bin/env bash
# Verifier #389 FINAL (seat 1): (1) 10 UNMUTATED repeats of the live probe attacks (timing arms must be stable before a timing kill counts); (2) probe mutants again, printing WHICH arms reddened.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"; V="$TMPDIR/v1"; M="$V/mut389f"
PROBE=(node --no-warnings --experimental-strip-types "$V/rig/probe-final.mjs" "$PWD")
fails=0
for i in $(seq 1 10); do "${PROBE[@]}" > "$V/rep-$i.out" 2>&1; rc=$?; s="$(grep -E '^SUMMARY' "$V/rep-$i.out")"; echo "repeat $i rc=$rc $s uptime=$(cut -d' ' -f1-3 /proc/loadavg)"; [[ $rc != 0 ]] && { fails=$((fails+1)); grep -E ' BAD ' "$V/rep-$i.out" | cut -c1-200; }; done
echo "UNMUTATED-REPEATS fails=$fails/10"
while IFS='|' read -r name file; do
  [[ "$name" == pm* ]] || continue
  out="$(MUT_TAIL=4000 bash "$V/rig/mut.sh" "$name" "$file" "$M/$name.old" "$M/$name.new" -- "${PROBE[@]}" 2>&1)"
  echo "$name restored=$(grep -c 'restored=yes' <<<"$out") reddened: $(grep -E '^[A-Z][0-9]+ +BAD' <<<"$out" | awk '{print $1}' | tr '\n' ' ')"
done < "$M/spec.txt"
git status --porcelain -uall | head -5; echo "tree clean check done"
