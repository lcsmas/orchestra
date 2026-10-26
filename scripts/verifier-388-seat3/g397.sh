#!/usr/bin/env bash
# Node-only part of the #397 gate on the trial merge 7aea7378 (= integration 2085903b + #395 ecbeabd5 + #397 bee13afb). NO Electron.
set -uo pipefail
T="$TMPDIR/wt-cand2"; V="$TMPDIR/v3rig"; L="$TMPDIR/g397"; mkdir -p "$L"; cd "$T" || exit 90
node "$V/g10.mjs" snap "$L/g10.before" >/dev/null
echo "HEAD=$(git rev-parse --short=8 HEAD) tree=$(git rev-parse HEAD^{tree} | cut -c1-8) porcelain=$(git status --porcelain | wc -l) delta-vs-integration: $(git diff --stat 2085903b HEAD | tail -1)"
nice -n 10 npx tsc --noEmit > "$L/tsc.log" 2>&1; echo "G2 tsc RC=$? errors=$(grep -c 'error TS' "$L/tsc.log")"
for n in 1 2 3; do
  echo "== G3 run $n"; echo "uptime-start: $(uptime | sed 's/.*load average: //')"
  nice -n 10 pnpm run test > "$L/run$n.log" 2>&1; echo "RC=$? tests=$(grep -E '^# tests' "$L/run$n.log" | awk '{print $3}') pass=$(grep -E '^# pass' "$L/run$n.log" | awk '{print $3}') fail=$(grep -E '^# fail' "$L/run$n.log" | awk '{print $3}') skipped=$(grep -E '^# skipped' "$L/run$n.log" | awk '{print $3}') uptime-end: $(uptime | sed 's/.*load average: //')"
  grep -E '^not ok' "$L/run$n.log" | cut -c1-170
  fails=$(grep -E "^\s+location: " "$L/run$n.log" | sed -E "s/.*'(.*):[0-9]+:[0-9]+'.*/\1/" | sort -u)
  for f in $fails; do for i in 1 2 3; do nice -n 10 node --test --experimental-strip-types "$f" > "$L/iso$n-$i-$(basename "$f").log" 2>&1; echo "  isolated ${f#$T/} run $i: $(grep -E '^# (tests|pass|fail|skipped)' "$L/iso$n-$i-$(basename "$f").log" | tr '\n' ' ')"; done; done
  [[ -z "$fails" ]] && { echo "  (full run $n green: no failing file)"; break; }
done
echo "== G4"; rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$L/bundles.log" 2>&1; echo "build:bundles RC=$?"; nice -n 10 pnpm run build:bus-abi > "$L/abi.log" 2>&1; echo "build:bus-abi RC=$?"
echo "== stub harnesses"
for h in verify-archive-browser-panel verify-browser-panel-dead-view verify-browser-panel-focus-steal verify-browser-tabs-panel; do node --experimental-strip-types "scripts/$h.mjs" > "$L/h-$h.log" 2>&1; echo "$h RC=$? $(grep -E 'passed$' "$L/h-$h.log")"; done
echo "== units (browser/proxy/CLI/ratchet)"
for t in $(git diff --name-only 2085903b HEAD | grep -E '\.test\.ts$') src/main/browser-panel-tabs.test.ts src/shared/browser-tab-policy.test.ts src/main/pause-gates-wiring.test.ts; do echo "$(node --test --experimental-strip-types "$t" 2>&1 | grep -E '^# (tests|pass|fail|skipped)' | tr '\n' ' ') $t"; done | sort -u
echo "== mutate-browser-agent-tabs (member's 55)"; node scripts/mutate-browser-agent-tabs.mjs > "$L/agent-tabs-mutants.log" 2>&1; echo "RC=$? $(tail -3 "$L/agent-tabs-mutants.log" | tr '\n' ' ')"; echo "  porcelain=$(git status --porcelain | wc -l) HEAD-tree=$(git rev-parse HEAD^{tree} | cut -c1-8)"
echo "== #393 stub mutants"; node scripts/verify-browser-tabs-panel-mutants.mjs > "$L/m393.log" 2>&1; echo "RC=$? $(tail -2 "$L/m393.log" | tr '\n' ' ')"; echo "  porcelain=$(git status --porcelain | wc -l)"
echo "== #391 mutants"; node scripts/mutate-browser-panel-tabs.mjs > "$L/m391.log" 2>&1; echo "RC=$? $(tail -2 "$L/m391.log" | tr '\n' ' ')"; echo "  porcelain=$(git status --porcelain | wc -l)"
node "$V/g10.mjs" snap "$L/g10.after" >/dev/null; node "$V/g10.mjs" diff "$L/g10.before" "$L/g10.after" | cut -c1-300
echo "ALLDONE"
