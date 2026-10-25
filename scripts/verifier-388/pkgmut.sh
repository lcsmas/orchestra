#!/usr/bin/env bash
set -uo pipefail
flock /var/tmp/orch-1000-b17728/pkg-388.lock nice -n 10 pnpm run build > "$TMPDIR/v1/pkgmut-build.log" 2>&1 || { echo "BUILD FAILED"; tail -5 "$TMPDIR/v1/pkgmut-build.log"; exit 97; }
echo "BUILT $(md5sum release/Orchestra.AppImage | cut -c1-12) $(stat -c %s release/Orchestra.AppImage)"
pnpm run test:pinned-node-app 2>&1
