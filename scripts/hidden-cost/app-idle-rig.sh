#!/usr/bin/env bash
# C2 #209 whole-app idle rig wrapper: own headless sway + env allowlist (scripts/e2e-contained-rig.sh), then the
# driver INSIDE a network+pid namespace (bwrap) so every network attempt is refused and every descendant is visible.
#   bash scripts/hidden-cost/app-idle-rig.sh [--ws 8] [--warm 20] [--measure 180] [--hidden 0] [--label x]
# Requires a fresh build:  pnpm run build:bundles   (the rig asserts dist/ + dist-electron/ exist, not that they are fresh —
# the report prints the build's package version + git sha).
set -eu
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
bash scripts/hidden-cost/execlog/build.sh >&2
command -v bwrap >/dev/null || { echo "bwrap missing" >&2; exit 2; }
LIVE_JSON="$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON -e "import('$REPO/scripts/session-budget/scratch-guard.mjs').then(m=>console.log(JSON.stringify(m.liveDirs())))")"
[ "${#LIVE_JSON}" -gt 4 ] || { echo "could not compute live dirs" >&2; exit 2; }
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/hidden-cost/rigs}"
exec bash scripts/e2e-contained-rig.sh \
  bwrap --dev-bind / / --unshare-net --unshare-pid --proc /proc --die-with-parent \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types "$REPO/scripts/hidden-cost/app-idle-rig.mjs" \
  --so "$REPO/scripts/hidden-cost/execlog/execlog.so" --live "$LIVE_JSON" --claude-dir "$(dirname "$(command -v claude)")" "$@"
