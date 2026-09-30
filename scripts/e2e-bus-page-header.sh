#!/usr/bin/env bash
# #253 — Bus page must render fully BELOW the top toolbar. Boots a BUILT Orchestra under its
# OWN headless sway (scripts/e2e-contained-rig.sh: marker-verified, `env -i` allowlist), seeds a
# scratch bus + an active workspace, opens the Bus page and asserts DOM + pixels.
# Driver: scripts/e2e-bus-page-header.mjs.
#
# Usage: scripts/e2e-bus-page-header.sh <app-dir> [--out <dir>] [--label <name>] [--expect-red] [--sizes min,typical]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/ incl. keeper.js); pass a
#              pre-fix build and the fixed build to compare the SAME rig on both.
#   --expect-red  the must-FAIL arm: exit 0 only if the layout clauses are RED and every
#                 positive-control clause is GREEN (a red for the wrong reason is a failure).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>] [--label <name>] [--expect-red] [--sizes min,typical]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles, plus pnpm run build:bus-abi so the app's bus opens)" >&2; exit 2; }
done

# btrfs under ~ (never /tmp: the fs is part of the instrument). Nothing here deletes anything.
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-bus-page-header}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }

# The app's CLAUDE_CONFIG_DIR is a SCRATCH dir — never a live ~/.claude* (app boot's account-inherit
# sync strips whatever dir it is handed). The contained rig forwards CLAUDE_CONFIG_DIR_PIN verbatim.
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
# `env -i` in the contained rig drops everything not allowlisted, so the real HOME (whose ~/.claude* and
# ~/.orchestra/bus.sqlite the driver snapshots before/after) travels as an ARGUMENT.
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-bus-page-header.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
