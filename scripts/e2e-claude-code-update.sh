#!/usr/bin/env bash
# « Mise à jour disponible » (Claude Code): the sidebar strip + `claude update`, driven in a BUILT Orchestra under its OWN headless sway
# (scripts/e2e-contained-rig.sh: marker-verified, `env -i` allowlist, private runtime dir), scratch HOME / ORCHESTRA_HOME / CLAUDE_CONFIG_DIR.
# Driver: scripts/e2e-claude-code-update.mjs (a fake native install + a local release channel; `--real-claude <binary>` for the real ones).
#
# Usage: scripts/e2e-claude-code-update.sh <app-dir> [--out <dir>] [--label <name>] [--real-claude <binary>]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/) with the Electron-ABI bus binding (pnpm run build:bundles && pnpm run build:bus-abi).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>] [--label <name>] [--real-claude <binary>]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/cli.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles, plus pnpm run build:bus-abi)" >&2; exit 2; }
done
awk '/MemAvailable/{exit !($2 > 6*1048576)}' /proc/meminfo || { echo "ABORT: MemAvailable <= 6 GB — an app under a compositor is refused" >&2; exit 2; }

export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-claude-code-update}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — use a disk-backed dir" >&2; exit 2; }

SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-claude-code-update.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
