#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel)"; V="$TMPDIR/v1"
nice -n 10 pnpm run build:bus-abi > "$V/bus-abi-400fix.log" 2>&1; echo "bus-abi RC=$?"
node --experimental-strip-types scripts/mutate-browser-profiles.mjs --check 2>&1 | tail -2 | cut -c1-160
export E2E_RIG_BASE=/var/tmp/v400-1000 RIG_HIDE_REAL_RUNTIME=1
bash "$V/rig/vhost/mk-vhost.sh" "$PWD" | tail -1
for arm in vhost-sweep vhost-band vhost-storm; do
  /var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/zz-verifier-vhost.sh "$PWD" --arms $arm --label fix-$arm --out "$V/vhost-shots" > "$V/fix-$arm.log" 2>&1; echo "ARM $arm RC=$?"
  grep -E "MEASURED \[vhost\] (profile, logout|rotation|EPHEMERAL)|\[vhost\] (logout-never|ctl/ephemeral|rotating|ctl/logout)|^VERDICT" "$V/fix-$arm.log" | cut -c1-330
done
rm -f scripts/zz-verifier-vhost.*
bash "$V/rig/run-fix-mutants.sh" vhost-band
echo "RUN400FIX-DONE"
