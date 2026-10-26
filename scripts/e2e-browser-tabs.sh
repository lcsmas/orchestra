#!/usr/bin/env bash
# #393 — browser tabs for the human, driven on the BUILT app inside its OWN headless sway (scripts/e2e-contained-rig.sh:
# marker-verified compositor, `env -i` allowlist, scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR). Driver: scripts/e2e-browser-tabs.mjs.
#
# Usage: scripts/e2e-browser-tabs.sh <app-dir> [--out <dir>] [--label <name>] [--arms tabs,cap,restore,paint,last]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/ incl. keeper.js); run `pnpm run build:bundles` and
#              `pnpm run build:bus-abi` first (the test run leaves node_modules at the Node ABI).
#   --arms     subset of arms (mutant builds only need the arm their mutant reddens); default = all.
# Exit 0 = every clause green; the must-FAIL builds are exercised by scripts/e2e-browser-tabs-mutants.mjs.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>] [--label <name>] [--arms tabs,cap,restore,paint,last]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles, plus pnpm run build:bus-abi)" >&2; exit 2; }
done

# Rig bound (ledger #405 §Briefing): one Electron rig at a time per member, only with >= 6 GB available.
avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
(( avail_kb >= 6*1024*1024 )) || { echo "ABORT: MemAvailable ${avail_kb} kB < 6 GB — the machine runs ~20 other agents" >&2; exit 2; }

# btrfs under ~ (never /tmp: tmpfs). Nothing here deletes anything.
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-browser-tabs}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }

# The app's CLAUDE_CONFIG_DIR is a SCRATCH dir — never a live ~/.claude* (app boot's account-inherit sync strips whatever dir it is handed).
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
# `env -i` in the contained rig drops everything not allowlisted: the real HOME (whose ~/.claude* the driver snapshots before/after) travels as an ARGUMENT.
exec nice -n 10 "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-browser-tabs.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
