#!/usr/bin/env bash
# #394 — browser tab memory attributed to the owning workspace, driven in a BUILT Orchestra under its OWN headless sway
# (scripts/e2e-contained-rig.sh: marker-verified, `env -i` allowlist), scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR.
# Driver: scripts/e2e-browser-tab-memory.mjs. HEAVY (a built app + two scratch sessions + a 400 MB page): ONE Electron rig at a time,
# MemAvailable >= 6 GB right before (refused otherwise).
#
# Usage: scripts/e2e-browser-tab-memory.sh <app-dir> [--out <dir>] [--label <name>] [--heavy-mb N] [--no-monitor]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/ incl. cli.js + keeper.js) with the Electron-ABI bus binding.
#   Run it on a build WITHOUT #394 (<app-dir> = an older tree) for the must-FAIL arm: the attribution clauses go RED.
# Fixture site: the worktree's scripts/fixtures/browser-site (#395's server.mjs + this ticket's memory-*.html pages); until #395 is merged
# into the tree, the server is read from $FIXTURE_REF (default origin/impl-proxy-cdp-cli-navigateur-395) into a scratch dir.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>] [--label <name>] [--heavy-mb N] [--no-monitor]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/cli.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles, plus pnpm run build:bus-abi)" >&2; exit 2; }
done
awk '/MemAvailable/{exit !($2 > 6*1048576)}' /proc/meminfo || { echo "ABORT: MemAvailable <= 6 GB — heavy rig refused (wave launch rule)" >&2; exit 2; }

export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-browser-tab-memory}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }

# Fixture dir = server.mjs + pages/, resolved ONCE here (the driver runs under `env -i`).
FIX="${REPO}/scripts/fixtures/browser-site"
if [[ ! -f "${FIX}/server.mjs" ]]; then
  REF="${FIXTURE_REF:-origin/impl-proxy-cdp-cli-navigateur-395}"
  FIX="$(mktemp -d "${E2E_RIG_BASE}/fixture-XXXXXX")"
  mkdir -p "${FIX}/pages"
  git -C "${REPO}" show "${REF}:scripts/fixtures/browser-site/server.mjs" > "${FIX}/server.mjs" || { echo "ABORT: no fixture server in the tree or at ${REF}" >&2; exit 2; }
  cp "${REPO}/scripts/fixtures/browser-site/pages/"memory-*.html "${FIX}/pages/"
fi
[[ -f "${FIX}/pages/memory-heavy.html" && -f "${FIX}/pages/memory-light.html" ]] || { echo "ABORT: ${FIX}/pages lacks the memory-*.html pages" >&2; exit 2; }

SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-browser-tab-memory.mjs" "${APP_DIR}" --live-home "${HOME}" --fixture-dir "${FIX}" "$@"
