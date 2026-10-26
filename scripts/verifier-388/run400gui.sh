#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel)"; V="$TMPDIR/v1"
export E2E_RIG_BASE=/var/tmp/v400-1000 RIG_HIDE_REAL_RUNTIME=1
/var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/e2e-browser-profiles.sh "$PWD" --label verifier-400 --out "$V/b400-shots" > "$V/b400-rig.log" 2>&1; echo "MEMBER-RIG RC=$?"
/var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/zz-verifier-vhost.sh "$PWD" --label verifier-400-vhost --out "$V/vhost-shots" > "$V/vhost-rig.log" 2>&1; echo "VHOST RC=$?"
echo "GUI-DONE"
