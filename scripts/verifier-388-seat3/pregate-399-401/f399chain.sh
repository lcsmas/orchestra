#!/usr/bin/env bash
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="/var/tmp/p399s3-$(id -u)"; mkdir -p -m 700 $E2E_RIG_BASE
V="$TMPDIR/v3rig"; WT="$TMPDIR/wt-gui399"; G=/var/tmp/orch-1000-b17728/gui-slot.sh; cd "$WT" || exit 90
echo "fingerprint before: main=$(md5sum dist-electron/main.js | cut -c1-12) cli=$(md5sum dist-electron/cli.js | cut -c1-12)"
echo "=== PARITY (all arms)"; bash "$V/g10wrap.sh" f399-parity -- "$G" bash scripts/e2e-browser-cli-parity.sh "$WT" --out "$V/runs/f399-out/parity" 2>&1 | grep -E "^G10" | cut -c1-120
grep -E "VERDICT|^  FAIL|^  GAP" "$V/runs/f399-parity.log" | cut -c1-260
echo "=== v3hid"; bash "$V/g10wrap.sh" f399-hid -- "$G" bash scripts/v3-skill-claims.sh "$WT" --arm v3hid --out "$V/runs/f399-out/hid" 2>&1 | grep -E "^G10" | cut -c1-120
grep -E "INFO  \[v3hid\]|^  (PASS|FAIL)  \[v3hid\]|VERDICT" "$V/runs/f399-hid.log" | cut -c1-700
echo "=== MUTANTS (sample)"; for m in skill-not-installed frames-guard load-events-dropped tab-close-preflight-off click-dropped; do
  bash "$V/g10wrap.sh" "f399-mut-$m" -- "$G" bash scripts/e2e-browser-cli-parity.sh "$WT" --mutant "$m" --out "$V/runs/f399-out/mut-$m" 2>&1 | grep -E "^G10" | cut -c1-90
  grep -E "^VERDICT" "$V/runs/f399-mut-$m.log" | cut -c1-260
done
echo "fingerprint after: main=$(md5sum dist-electron/main.js | cut -c1-12) cli=$(md5sum dist-electron/cli.js | cut -c1-12)"; git status --porcelain | grep -v '^??' | cat; echo CHAIN-DONE
