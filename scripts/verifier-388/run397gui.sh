#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel)"; V="$TMPDIR/v1"
export E2E_RIG_BASE=/var/tmp/v397-1000 RIG_HIDE_REAL_RUNTIME=1
SLOT=/var/tmp/orch-1000-b17728/gui-slot.sh
$SLOT bash scripts/e2e-browser-agent-tabs.sh "$PWD" --out "$V/b397-shots" > "$V/b397-rig.log" 2>&1; echo "MEMBER-RIG RC=$?"
bash "$V/rig/mk-thost.sh" "$PWD" > "$V/mk-thost.log" 2>&1; tail -1 "$V/mk-thost.log"
for arm in thostile tdetach tflake; do
  $SLOT bash scripts/zz-verifier-thost.sh "$PWD" --arm $arm --out "$V/b397-shots" > "$V/b397-$arm.log" 2>&1; echo "ARM $arm RC=$?"
done
rm -f scripts/zz-verifier-thost.*
for m in close-any-tab preflight-off ref-spelling-exact destroyers-allowed child-close-allowed background-activates attach-is-acting; do
  $SLOT bash scripts/e2e-browser-agent-tabs.sh "$PWD" --mutant $m --out "$V/b397-mut" > "$V/b397-mut-$m.log" 2>&1; echo "MUTANT $m RC=$? $(grep -E '^VERDICT' "$V/b397-mut-$m.log" | tail -1 | cut -c1-200)"
done
echo "GUI-DONE"
