#!/usr/bin/env bash
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="/var/tmp/p399s3-$(id -u)"; mkdir -p -m 700 $E2E_RIG_BASE
V="$TMPDIR/v3rig"; WT="$TMPDIR/wt-gui399"; G=/var/tmp/orch-1000-b17728/gui-slot.sh; cd "$WT" || exit 90
echo "tip $(git rev-parse --short=8 HEAD) main=$(md5sum dist-electron/main.js | cut -c1-12) (clean $(cat $TMPDIR/clean399v2.md5))"
echo "=== PARITY (all arms)"; bash "$V/g10wrap.sh" f399v2-parity -- "$G" bash scripts/e2e-browser-cli-parity.sh "$WT" --out "$V/runs/f399-out/v2parity" 2>&1 | grep -E "^G10 " | cut -c1-100
grep -E "VERDICT|^  FAIL|^  GAP" "$V/runs/f399v2-parity.log" | cut -c1-240
grep -E "\[skill-profile\]" "$V/runs/f399v2-parity.log" | sed -E 's/^  (PASS|FAIL)  /\1 /' | cut -c1-330
echo "=== v3prof"; bash "$V/g10wrap.sh" f399v2-prof -- "$G" bash scripts/v3-skill-claims.sh "$WT" --arm v3prof --out "$V/runs/f399-out/v2prof" 2>&1 | grep -E "^G10 " | cut -c1-100
grep -E "INFO  \[v3prof\]|^  (PASS|FAIL)  \[v3prof\]|VERDICT" "$V/runs/f399v2-prof.log" | cut -c1-520
echo "main after: $(md5sum dist-electron/main.js | cut -c1-12)"; git status --porcelain | grep -v '^??' | cat; echo CHAIN-V2-DONE
