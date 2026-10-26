#!/usr/bin/env bash
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1
V="$TMPDIR/v3rig"; WT="$TMPDIR/wt-gui"; G=/var/tmp/orch-1000-b17728/gui-slot.sh
bash "$V/mut397g.sh"
cd "$WT" || exit 90
export E2E_RIG_BASE="/var/tmp/b397s3-$(id -u)"; mkdir -p -m 700 "$E2E_RIG_BASE"
echo "pre-member-mutants fingerprint: main=$(md5sum dist-electron/main.js | cut -c1-12) cli=$(md5sum dist-electron/cli.js | cut -c1-12)"
for m in internal-nav-allowed internal-nav-guards-agent; do
  echo "=== MEMBER MUTANT $m"
  nice -n 10 bash "$V/g10wrap.sh" "f4-mm-$m" -- "$G" bash scripts/e2e-browser-agent-tabs.sh "$WT" --mutant "$m" --out "$V/runs/g397-out/mm-$m" 2>&1 | grep -E "^(G10|G10WRAP)" | cut -c1-120
  grep -E "^(VERDICT|\[mutant\]|REFUSED|ABORT)|FAIL  " "$V/runs/f4-mm-$m.log" | cut -c1-300 | head -10
done
echo "post fingerprint: main=$(md5sum dist-electron/main.js | cut -c1-12) cli=$(md5sum dist-electron/cli.js | cut -c1-12)"; git status --porcelain | grep -v '^??' | cat; echo CHAIN-DONE
