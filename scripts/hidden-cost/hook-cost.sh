#!/usr/bin/env bash
# C2 #209 per-hook cost wrapper: scratch HOME/ORCHESTRA_HOME under ~/.cache/hidden-cost (never a live dir), env allowlist,
# LD_PRELOAD exec logger passed to the HOOKS only. NOT netns-wrapped: the machine's `orchestra` shim execs the installed
# AppImage, which cannot FUSE-mount inside bwrap (measured: "Cannot mount AppImage") — hooks make no network calls.
#   bash scripts/hidden-cost/hook-cost.sh [--runs 15] [--peers 12] [--with-orchestra-cli 1]
set -eu
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
bash scripts/hidden-cost/execlog/build.sh >&2
LIVE_JSON="$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON -e "import('$REPO/scripts/session-budget/scratch-guard.mjs').then(m=>console.log(JSON.stringify(m.liveDirs())))")"
[ "${#LIVE_JSON}" -gt 4 ] || { echo "could not compute live dirs" >&2; exit 2; }
ROOT="$HOME/.cache/hidden-cost/hook-$$"
mkdir -p "$ROOT"
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$ROOT/home" LANG=C.UTF-8 HC_ROOT="$ROOT" HC_ORCHESTRA_BIN_DIR="$HOME/.orchestra/bin" \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --import "$REPO/scripts/.r2-register.mjs" \
  "$REPO/scripts/hidden-cost/hook-cost.mjs" --so "$REPO/scripts/hidden-cost/execlog/execlog.so" --live "$LIVE_JSON" "$@"
