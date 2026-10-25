#!/usr/bin/env bash
# Run under mut.sh (source already mutated): rebuild bundles, print the built-artifact fingerprint (mutant liveness), drive the built app, print FAIL clauses.
set -uo pipefail
RIGDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nice -n 10 pnpm run build:bundles > "$TMPDIR/drivemut-build.log" 2>&1 || { echo "BUILD FAILED"; tail -5 "$TMPDIR/drivemut-build.log"; exit 97; }
for f in dist-electron/index-*.js; do echo "BUILT $f removeChildView=$(grep -o 'removeChildView(' "$f" | wc -l) md5=$(md5sum "$f" | cut -c1-12)"; done
export E2E_RIG_BASE="/var/tmp/v388-$(id -u)"; export CLAUDE_CONFIG_DIR_PIN="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
nice -n 10 bash scripts/e2e-contained-rig.sh node "$RIGDIR/bp-drive.mjs" "$PWD" "mutant-${MUT_LABEL:-x}" > "$TMPDIR/drivemut-${MUT_LABEL:-x}.log" 2>&1
RC=$?
grep -E '^(FAIL|RIG-RESULT)' "$TMPDIR/drivemut-${MUT_LABEL:-x}.log" | cut -c1-330
exit $RC
