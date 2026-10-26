#!/usr/bin/env bash
# The member's 12 bundle mutants (e2e-browser-agent-tabs.sh --mutant), each ONE rig invocation through gui-slot.sh, G10 around each. Seat 3.
set -uo pipefail
export V3_FREEZE_LIFTED=1 # OPS 9191: contained-rig GUI runs allowed (private runtime world); the real bus is never read
WT="$TMPDIR/wt-gui"; V="$TMPDIR/v3rig"; G=/var/tmp/orch-1000-b17728/gui-slot.sh; export E2E_RIG_BASE="/var/tmp/b397s3-$(id -u)"; mkdir -p -m 700 "$E2E_RIG_BASE"
export RIG_HIDE_REAL_RUNTIME=1
cd "$WT" || exit 90
echo "BUNDLE-FINGERPRINT before: main=$(md5sum dist-electron/main.js | cut -c1-12) cli=$(md5sum dist-electron/cli.js | cut -c1-12) chunks=$(cat dist-electron/index-*.js | md5sum | cut -c1-12) css=$(cat dist/assets/*.css | md5sum | cut -c1-12) marker=$(ls dist-electron/.b397-mutant-active 2>/dev/null | wc -l)"
for spec in "cap-bypass:cap" "close-any-tab:ownership" "preflight-off:ownership,restart" "list-unannotated:open" "no-front-on-acting:front,refs" "no-front-at-all:front,refs" "notice-in-flow:open" "switch-unannotated:restart" "child-close-allowed:children" "silent-swap:open,front" "background-activates:background" "stale-map:refs"; do
  m="${spec%%:*}"; arms="${spec#*:}"
  echo "=== MUTANT $m (arms $arms)"
  nice -n 10 bash "$V/g10wrap.sh" "mut397-$m" -- "$G" bash scripts/e2e-browser-agent-tabs.sh "$WT" --mutant "$m" --arm "$arms" --out "$V/runs/mut397-out/$m" 2>&1 | grep -E "^(G10|G10WRAP)" | cut -c1-260
  grep -E "^(VERDICT|\[mutant\]|REFUSED|ABORT)|FAIL  " "$V/runs/mut397-$m.log" | cut -c1-300 | head -14
done
echo "BUNDLE-FINGERPRINT after:  main=$(md5sum dist-electron/main.js | cut -c1-12) cli=$(md5sum dist-electron/cli.js | cut -c1-12) chunks=$(cat dist-electron/index-*.js | md5sum | cut -c1-12) css=$(cat dist/assets/*.css | md5sum | cut -c1-12) marker=$(ls dist-electron/.b397-mutant-active 2>/dev/null | wc -l)"
echo ALLDONE
