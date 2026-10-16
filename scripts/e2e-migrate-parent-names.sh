#!/usr/bin/env bash
# #385 — the parent-name migration script driven against a BUILT Orchestra: seeded store with a spawned child → `scripts/migrate-parent-names.mjs --apply` through the REAL built CLI
# (dist-electron/cli.js) → the child is renamed AS its parent, `namedByParent` kept, `formerBranch` recorded, shown "ex-…". Runs in the contained rig's OWN headless sway
# (scripts/e2e-contained-rig.sh: marker-verified, `env -i` allowlist), scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR. Driver: scripts/e2e-migrate-parent-names.mjs.
#
# Usage: scripts/e2e-migrate-parent-names.sh <app-dir> [--out <dir>] [--label <name>]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/ incl. cli.js + keeper.js) with the Electron-ABI bus binding (pnpm run build:bundles && pnpm run build:bus-abi).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>] [--label <name>]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/cli.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles, plus pnpm run build:bus-abi)" >&2; exit 2; }
done
awk '/MemAvailable/{exit !($2 > 3*1048576)}' /proc/meminfo || { echo "ABORT: MemAvailable <= 3 GB — an Electron instance needs headroom" >&2; exit 2; }

export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-migrate-parent-names}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }

SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-migrate-parent-names.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
