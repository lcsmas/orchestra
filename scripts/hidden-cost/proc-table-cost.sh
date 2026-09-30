#!/usr/bin/env bash
# wrapper: scratch HOME/ORCHESTRA_HOME under ~/.cache/hidden-cost, env allowlist (D7). Prints one JSON line.
set -eu
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
LIVE_JSON="$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON -e "import('$REPO/scripts/session-budget/scratch-guard.mjs').then(m=>console.log(JSON.stringify(m.liveDirs())))")"
ROOT="$HOME/.cache/hidden-cost/proctable-$$"; mkdir -p "$ROOT"
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$ROOT/home" LANG=C.UTF-8 HC_ROOT="$ROOT" \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --import "$REPO/scripts/.r2-register.mjs" \
  "$REPO/scripts/hidden-cost/proc-table-cost.mjs" --live "$LIVE_JSON"
