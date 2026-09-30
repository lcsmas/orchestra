#!/usr/bin/env bash
# Built-app proof for #235 residual (C10): boots a BUILT Orchestra under its OWN headless sway on a SCRATCH
# HOME + scratch config dir, seeded with an EMPTY-`inherit` account over a live-shaped dir. Driver + arms:
# scripts/e2e-inherit-empty-boot.mjs. Containment (own sway, marker-verified, `env -i` allowlist) is
# e2e-contained-rig.sh's; this wrapper pins the child's CLAUDE_CONFIG_DIR to a SCRATCH dir (never a live one).
#
# Usage: scripts/e2e-inherit-empty-boot.sh <app-dir> [--arm a,b] [--list]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/main.js + keeper.js); run the SAME rig on a
#              pre-change build and the candidate build to compare.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for a in "$@"; do
  [[ "$a" == "--list" ]] && exec node "${HERE}/e2e-inherit-empty-boot.mjs" --list
done
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--arm a,b] [--list]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js node_modules/electron/dist/electron; do
  [[ -e "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles)" >&2; exit 2; }
done
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-inherit-empty-boot}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
# The child's CLAUDE_CONFIG_DIR: a SCRATCH dir under the rig base — the contained rig defaults it to $HOME/.claude (LIVE).
export CLAUDE_CONFIG_DIR_PIN="${E2E_RIG_BASE}/pin-config"
mkdir -p "${CLAUDE_CONFIG_DIR_PIN}"
# Foreground, no inner `&`: the contained rig tears its sway down on exit.
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-inherit-empty-boot.mjs" "${APP_DIR}" "$@"
