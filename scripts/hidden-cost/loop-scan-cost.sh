#!/usr/bin/env bash
# C2 #209 loop-scan sweep cost wrapper (scratch HOME/ORCHESTRA_HOME/config dir under ~/.cache/hidden-cost, env allowlist).
#   bash scripts/hidden-cost/loop-scan-cost.sh [--ws 32] [--runs 5]
set -eu
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
LIVE_JSON="$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON -e "import('$REPO/scripts/session-budget/scratch-guard.mjs').then(m=>console.log(JSON.stringify(m.liveDirs())))")"
[ "${#LIVE_JSON}" -gt 4 ] || { echo "could not compute live dirs" >&2; exit 2; }
ROOT="$HOME/.cache/hidden-cost/loopscan-$$"
mkdir -p "$ROOT"
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$ROOT/home" LANG=C.UTF-8 HC_ROOT="$ROOT" \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --import "$REPO/scripts/.r2-register.mjs" \
  "$REPO/scripts/hidden-cost/loop-scan-cost.mjs" --live "$LIVE_JSON" "$@"
rc=$?
cp "$ROOT/loop-scan-cost.json" "${HC_OUT:-/dev/null}" 2>/dev/null || true
exit $rc
