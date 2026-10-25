#!/usr/bin/env bash
# #391 — tabs-registry E2E on a BUILT app in the contained rig's own headless sway.
# Usage: scripts/e2e-browser-tabs-registry.sh <app-dir> [--arm app,probe] [--mutant destroy-active-only|no-detach-prev] [--out dir]
#   <app-dir> a BUILT checkout (package.json + dist/ + dist-electron/ incl. keeper.js).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--arm app,probe] [--mutant name] [--out dir]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles)" >&2; exit 2; }
done
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/avr-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} not mine" >&2; exit 2; }
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base is tmpfs" >&2; exit 2; }
LIVE_CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"   # only SNAPSHOTTED (sha256 before/after), never used
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-browser-tabs-registry.mjs" "${APP_DIR}" --live-cfg "${LIVE_CFG}" "$@"
