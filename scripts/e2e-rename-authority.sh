#!/usr/bin/env bash
# #383 G6 — rename authority on a BUILT Orchestra, inside the contained rig (own headless sway, `env -i` allowlist, scratch HOME/ORCHESTRA_HOME/CLAUDE_CONFIG_DIR).
# Driver: scripts/e2e-rename-authority.mjs. Usage: scripts/e2e-rename-authority.sh <app-dir> [--out <dir>] [--label <name>] [--expect-red]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/ incl. cli.js + keeper.js; `pnpm run build:bundles` + `pnpm run build:bus-abi`).
#   --expect-red  the must-FAIL arm for a pre-#383 build: exit 0 only if every authority clause is RED and every keeper/control GREEN.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>] [--label <name>] [--expect-red]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js dist-electron/cli.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles, plus pnpm run build:bus-abi)" >&2; exit 2; }
done
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-rename-authority}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-rename-authority.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
