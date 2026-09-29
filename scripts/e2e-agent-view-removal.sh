#!/usr/bin/env bash
# Removal-assertion E2E rig for wave "Agent view only" (#219 / #225): boots a BUILT
# Orchestra under its OWN headless sway and reports the rendered workspace tabs + the
# live PTY sessions by kind. Driver + arms: scripts/e2e-agent-view-removal.mjs.
#
# Usage: scripts/e2e-agent-view-removal.sh <app-dir> [--mode baseline|after] [--arm a,b] [--list]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/); pass a pre-change
#              build and a candidate build to compare the SAME rig on both.
# Containment (own sway, marker-verified, `env -i` allowlist) is e2e-contained-rig.sh's;
# this wrapper only pins the account from the INVOKING agent's login and puts the rig dir
# on btrfs under ~ (never /tmp: the fs is part of the instrument).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `--list` needs no app and no compositor.
for a in "$@"; do
  [[ "$a" == "--list" ]] && exec node "${HERE}/e2e-agent-view-removal.mjs" --list
done

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--mode baseline|after] [--arm a,b] [--list]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (npx vite build)" >&2; exit 2; }
done

# Pin: the invoking agent's own login, derived here, never a hardcoded account.
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
[[ -d "${CFG}" ]] || { echo "ABORT: config dir ${CFG} does not exist" >&2; exit 2; }
echo "[avr] pinned configDir=${CFG} (from \${CLAUDE_CONFIG_DIR:-\$HOME/.claude})" >&2

export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-agent-view-removal}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
export CLAUDE_CONFIG_DIR_PIN="${CFG}"

# Foreground, no inner `&`: the contained rig tears its sway down on exit.
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-agent-view-removal.mjs" "${APP_DIR}" "$@"
