#!/usr/bin/env bash
# Node-only gate of #396 (NO Electron, NO bus, NO G10b — freeze). Scratch tree wt-cand2.
set -uo pipefail
T="$TMPDIR/wt-cand2"; V="$TMPDIR/v3rig"; L="$TMPDIR/g396"; mkdir -p "$L"; cd "$T" || exit 90
node "$V/g10.mjs" snap "$L/g10.before" >/dev/null
echo "== G1"; git fetch -q origin impl-popups-fenetre-oauth-396 ops-browser-orca-388 2>&1 | tail -1
TIP="$(git ls-remote origin refs/heads/impl-popups-fenetre-oauth-396 | cut -f1)"; ITIP="$(git ls-remote origin refs/heads/ops-browser-orca-388 | cut -f1)"
git checkout -q --detach "$TIP" || exit 91
MB="$(git merge-base "$ITIP" HEAD)"; echo "G1 ls-remote=${TIP:0:8} HEAD=$(git rev-parse --short=8 HEAD) integration(ls-remote)=${ITIP:0:8} merge-base=${MB:0:8} rebased=$([[ "$MB" == "$ITIP" ]] && echo YES || echo NO) ahead=$(git rev-list --count "$ITIP..HEAD") $(git diff --stat "$ITIP" HEAD | tail -1) porcelain=$(git status --porcelain | wc -l)"
nice -n 10 npx tsc --noEmit > "$L/tsc.log" 2>&1; echo "G2 tsc RC=$? errors=$(grep -c 'error TS' "$L/tsc.log")"
echo "== G3 run 1"; echo "uptime-start: $(uptime | sed 's/.*load average: //')"
nice -n 10 pnpm run test > "$L/run1.log" 2>&1; echo "RC=$? tests=$(grep -E '^# tests' "$L/run1.log" | awk '{print $3}') pass=$(grep -E '^# pass' "$L/run1.log" | awk '{print $3}') fail=$(grep -E '^# fail' "$L/run1.log" | awk '{print $3}') skipped=$(grep -E '^# skipped' "$L/run1.log" | awk '{print $3}') uptime-end: $(uptime | sed 's/.*load average: //')"
grep -E '^not ok' "$L/run1.log" | cut -c1-170
for f in $(grep -E "^\s+location: " "$L/run1.log" | sed -E "s/.*'(.*):[0-9]+:[0-9]+'.*/\1/" | sort -u); do for i in 1 2 3; do nice -n 10 node --test --experimental-strip-types "$f" > "$L/iso-$i-$(basename "$f").log" 2>&1; echo "  isolated ${f#$T/} run $i: $(grep -E '^# (tests|pass|fail|skipped)' "$L/iso-$i-$(basename "$f").log" | tr '\n' ' ')"; done; done
echo "== G4 (bundles only; no GUI)"; rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$L/bundles.log" 2>&1; echo "build:bundles RC=$?"
echo "== harnesses"
for h in verify-archive-browser-panel verify-browser-panel-dead-view verify-browser-panel-focus-steal verify-browser-tabs-panel; do node --experimental-strip-types "scripts/$h.mjs" > "$L/h-$h.log" 2>&1; echo "$h RC=$? $(grep -E 'passed$' "$L/h-$h.log")"; done
echo "== popup/tab units"
for t in $(git diff --name-only "$ITIP" HEAD | grep -E '\.test\.ts$'); do echo "$(node --test --experimental-strip-types "$t" 2>&1 | grep -E '^# (tests|pass|fail|skipped)' | tr '\n' ' ') $t"; done
echo "== mutate-browser-popups"; node scripts/mutate-browser-popups.mjs > "$L/popups-mutants.log" 2>&1; echo "RC=$? $(tail -3 "$L/popups-mutants.log" | tr '\n' ' ')"; echo "  porcelain=$(git status --porcelain | wc -l)"
echo "== #393 stub mutants"; node scripts/verify-browser-tabs-panel-mutants.mjs > "$L/m393.log" 2>&1; echo "RC=$? $(tail -2 "$L/m393.log" | tr '\n' ' ')"; echo "  porcelain=$(git status --porcelain | wc -l)"
echo "== #391 mutants"; node scripts/mutate-browser-panel-tabs.mjs > "$L/m391.log" 2>&1; echo "RC=$? $(tail -2 "$L/m391.log" | tr '\n' ' ')"; echo "  porcelain=$(git status --porcelain | wc -l)"
node "$V/g10.mjs" snap "$L/g10.after" >/dev/null; node "$V/g10.mjs" diff "$L/g10.before" "$L/g10.after" | cut -c1-300
echo "ALLDONE"
