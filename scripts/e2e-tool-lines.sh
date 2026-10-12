#!/usr/bin/env bash
# #374 — desktop tool lines (one line per tool, like the phone). Boots a BUILT Orchestra under its OWN headless sway
# (scripts/e2e-contained-rig.sh: marker-verified, `env -i` allowlist), seeds a transcript with an ok / failed / running
# tool + a TodoWrite, and asserts DOM + computed colours + pixels + trusted clicks. Driver: scripts/e2e-tool-lines.mjs.
#
# Usage: scripts/e2e-tool-lines.sh <app-dir> [--out <dir>] [--label <name>] [--expect-red]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/ incl. keeper.js); pass a master build and this
#              branch's build to compare the SAME rig on both.
#   --expect-red  the must-FAIL arm: exit 0 only if every line clause is RED and every positive control GREEN.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>] [--label <name>] [--expect-red]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles)" >&2; exit 2; }
done

# btrfs under ~ (never /tmp). Nothing here deletes anything.
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-tool-lines}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }

# The app's CLAUDE_CONFIG_DIR is a SCRATCH dir — never a live ~/.claude* (app boot's account-inherit sync strips whatever dir it is handed).
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
# `env -i` in the contained rig drops everything not allowlisted, so the real HOME (whose ~/.claude* the driver snapshots before/after) travels as an ARGUMENT.
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-tool-lines.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
