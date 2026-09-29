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
# It is only ever PROTECTED, never used — a missing dir is not an error (the driver skips its cases and snapshots).
[[ -d "${CFG}" ]] || echo "[avr] WARN: config dir ${CFG} does not exist — nothing to protect there" >&2
echo "[avr] live config dir to PROTECT (never used as the app's account): ${CFG}" >&2

export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-agent-view-removal}"
mkdir -p "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
export CLAUDE_CONFIG_DIR_PIN="${CFG}"   # name kept: e2e-contained-rig.sh forwards it as the child's CLAUDE_CONFIG_DIR
# Retention: the driver deletes a PASSED arm's bulky state and prunes only stale (>24 h), unreferenced e2e64c-* dirs
# (sibling-safe; see pruneStaleRigDirs) — the wrapper itself deletes nothing.

# Foreground, no inner `&`: the contained rig tears its sway down on exit.
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-agent-view-removal.mjs" "${APP_DIR}" "$@"
