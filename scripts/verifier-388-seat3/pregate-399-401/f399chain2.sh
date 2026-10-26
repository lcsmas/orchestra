#!/usr/bin/env bash
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="/var/tmp/p399s3-$(id -u)"
V="$TMPDIR/v3rig"; WT="$TMPDIR/wt-gui399"; G=/var/tmp/orch-1000-b17728/gui-slot.sh; cd "$WT" || exit 90
for m in no-auto-open navigate-dropped history-dropped insert-text-dropped eval-dropped; do
  bash "$V/g10wrap.sh" "f399-mut-$m" -- "$G" bash scripts/e2e-browser-cli-parity.sh "$WT" --mutant "$m" --out "$V/runs/f399-out/mut-$m" 2>&1 | grep -E "^G10 " | cut -c1-60
  echo "$m: $(grep -E '^VERDICT' "$V/runs/f399-mut-$m.log" | cut -c1-230)"
done
echo "fingerprint after: main=$(md5sum dist-electron/main.js | cut -c1-12) cli=$(md5sum dist-electron/cli.js | cut -c1-12)"; git status --porcelain | grep -v '^??' | cat
cd "$TMPDIR/wt-cand2" || exit 91
for a in normal browser-mcp-registered; do echo "=== session-budget arm $a"; nice -n 10 bash scripts/e2e-session-budget.sh --arm $a 2>&1 | grep -E "^== arm|SESSION-BUDGET" | cut -c1-260; done
git status --porcelain | grep -v '^??' | cat; echo CHAIN2-DONE
