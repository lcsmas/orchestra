#!/usr/bin/env bash
# Removal-assertion E2E rig for wave "Agent view only" (#219 / #225): boots a BUILT
# Orchestra under its OWN headless sway and reports the rendered workspace tabs + the
# live PTY sessions by kind. Driver + arms: scripts/e2e-agent-view-removal.mjs.
#
# Usage: scripts/e2e-agent-view-removal.sh <app-dir> [--mode baseline|after] [--arm a,b] [--list] [--broken-control] [--allow-stale]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/); pass a pre-change
#              build and a candidate build to compare the SAME rig on both.
# Containment (own sway, marker-verified, `env -i` allowlist) is e2e-contained-rig.sh's;
# this wrapper only tells the driver which live config dir to PROTECT (the app runs on a
# scratch account dir) and puts the rig dir on btrfs under ~ (never /tmp: the fs is part of the instrument).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `--list` needs no app and no compositor.
for a in "$@"; do
  [[ "$a" == "--list" ]] && exec node "${HERE}/e2e-agent-view-removal.mjs" --list
done

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--mode baseline|after] [--arm a,b] [--list] [--broken-control] [--allow-stale]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (npx vite build)" >&2; exit 2; }
done

# The invoker's LIVE config dir is never the app's account (review F1 on #225: the app boot's
# account-inherit sync strips a live dir under this rig's fake HOME). It is passed through only so
# the driver can assert, before/after every boot, that it was left untouched.
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
[[ -d "${CFG}" ]] || { echo "ABORT: config dir ${CFG} does not exist" >&2; exit 2; }
echo "[avr] live config dir to PROTECT (never used as the app's account): ${CFG}" >&2

export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-agent-view-removal}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
export CLAUDE_CONFIG_DIR_PIN="${CFG}"   # name kept: e2e-contained-rig.sh forwards it as the child's CLAUDE_CONFIG_DIR
# F4 retention: keep the newest 5 rig dirs (pattern e2e64c-*, this rig's own base); the driver also deletes a
# PASSED arm's bulky state and keeps FAILED arms whole for forensics.
PRUNE="$(find "${E2E_RIG_BASE}" -maxdepth 1 -type d -name 'e2e64c-*' -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2-)"
if [[ -n "${PRUNE}" ]]; then printf '%s\n' "${PRUNE}" | xargs -r rm -rf; echo "[avr] pruned $(printf '%s\n' "${PRUNE}" | wc -l) older rig dir(s), kept the newest 5 under ${E2E_RIG_BASE}" >&2; fi

# Foreground, no inner `&`: the contained rig tears its sway down on exit.
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-agent-view-removal.mjs" "${APP_DIR}" "$@"
