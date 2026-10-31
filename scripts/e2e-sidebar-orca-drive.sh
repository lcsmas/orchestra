#!/usr/bin/env bash
# Orca-style sidebar drive — selection fold/unfold, sliding selection frame, coordinator rollup, root-only bell.
# Driver: scripts/e2e-sidebar-orca-drive.mjs.
# Usage: scripts/e2e-sidebar-orca-drive.sh <app-dir>     (<app-dir> = a BUILT checkout: pnpm run build:bus-abi && pnpm run build:bundles)
# Containment (own sway, marker-verified, `env -i` allowlist) is e2e-contained-rig.sh's; the app runs on a SCRATCH account dir
# under a fake HOME — the invoker's live config dir is only ever snapshotted before/after, never handed to the app.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir>" >&2; exit 2; }
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js dist-electron/cli.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bus-abi && pnpm run build:bundles)" >&2; exit 2; }
done
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
echo "[sor] live config dir to PROTECT (never used as the app's account): ${CFG}" >&2
# SHORT base on purpose: the keeper socket path (<home>/keepers/<ws>.sock) must stay <= 100 chars (see e2e-agent-view-removal.sh).
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/sor-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not a directory owned by me (or is a symlink)" >&2; exit 2; }
chmod 700 "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs" >&2; exit 2; }
export CLAUDE_CONFIG_DIR_PIN="${CFG}"   # forwarded by e2e-contained-rig.sh as the child's CLAUDE_CONFIG_DIR; the driver only PROTECTS it
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-sidebar-orca-drive.mjs" "${APP_DIR}"
