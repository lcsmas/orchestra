#!/usr/bin/env bash
# drivemut393.sh <label> <arms|all> — run under mut.sh (source already mutated): CLEAN rebuild (rm dist*), bus-abi, fingerprint, drive the BUILT mutant with tabs-drive.mjs under G10/G10b.
set -uo pipefail
LBL="$1"; ARMS="${2:-all}"; ROOT="$(git rev-parse --show-toplevel)"; V="$TMPDIR/v3rig"; cd "$ROOT" || exit 90
rm -rf dist dist-electron
nice -n 10 pnpm run build:bundles > "$TMPDIR/drivemut-build-$LBL.log" 2>&1 || { echo "BUILD FAILED"; tail -5 "$TMPDIR/drivemut-build-$LBL.log"; exit 97; }
nice -n 10 pnpm run build:bus-abi > "$TMPDIR/drivemut-abi-$LBL.log" 2>&1 || { echo "BUS-ABI FAILED"; exit 98; }
echo "BUILT $LBL main.js=$(md5sum dist-electron/main.js | cut -c1-12) renderer=$(cat dist/assets/index-*.js | md5sum | cut -c1-12)"
bash "$V/rigrun.sh" "mut-$LBL" "$ROOT" "$V/tabs-drive.mjs" "$LBL" "$ARMS"
