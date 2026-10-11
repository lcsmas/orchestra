#!/usr/bin/env bash
# Accès mobile #334 — end-to-end drive of a BUILT Orchestra under its OWN headless sway (scripts/e2e-contained-rig.sh,
# `env -i` allowlist) + a headless Chromium in iPhone emulation. Driver: scripts/e2e-acces-mobile.mjs.
# Usage: scripts/e2e-acces-mobile.sh <app-dir> [--out <dir>]   (build first: pnpm run build:bundles && pnpm run build:bus-abi)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" && pwd)"
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js dist-electron/acces-mobile.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — pnpm run build:bundles first" >&2; exit 2; }
done
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-acces-mobile}"
mkdir -p "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base on tmpfs" >&2; exit 2; }
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-acces-mobile.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
