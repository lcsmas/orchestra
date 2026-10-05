#!/usr/bin/env bash
# #257 G3 — drive the fleet Pause UI on a BUILT Orchestra under its OWN headless sway (scripts/e2e-contained-rig.sh: marker-verified, `env -i` allowlist), scratch ORCHESTRA_HOME /
# HOME / CLAUDE_CONFIG_DIR, a scratch fleet of real git worktrees, a bus seeded with the SHIPPED writers. Driver: scripts/pause-ui/e2e-pause-ui.mjs.
# Usage: scripts/pause-ui/e2e-pause-ui.sh <app-dir | --packaged <bin>> [--out <dir>] [--label <name>] [--arms ipc,ui] [--expect-red]
#   <app-dir>   a BUILT checkout (package.json + dist/ + dist-electron/); `--packaged <bin>` = the unpacked `orchestra` binary of a packaged build.
#   --expect-red  the must-FAIL arm: against a build WITHOUT the feature (master) every G-clause must be RED and every ctl/* clause GREEN.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
[[ $# -ge 1 ]] || { echo "usage: $0 <app-dir | --packaged <bin>> [--out <dir>] [--label <name>] [--arms ipc,ui] [--expect-red]" >&2; exit 2; }
if [[ "$1" == "--packaged" ]]; then
  APP="$2"; [[ -x "${APP}" ]] || { echo "ABORT: ${APP} is not executable" >&2; exit 2; }
  ARGS=(--packaged "$(realpath "${APP}")"); shift 2
else
  APP="$(cd "$1" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
  for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
    [[ -f "${APP}/${f}" ]] || { echo "ABORT: ${APP}/${f} missing — build first (pnpm run build:bundles; pnpm run build:bus-abi so the app's bus opens)" >&2; exit 2; }
  done
  ARGS=("${APP}"); shift
fi
# btrfs under ~ (never /tmp: the fs is part of the instrument). Nothing here deletes anything.
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-pause-ui}"
mkdir -p "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
# refuse to start a heavy rig on a loaded / low-memory machine (wave F D6)
avail_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"; load1="$(cut -d' ' -f1 /proc/loadavg)"
[[ "${avail_kb}" -ge 6000000 ]] || { echo "ABORT: MemAvailable ${avail_kb} kB < 6 GB" >&2; exit 2; }
awk -v l="${load1}" 'BEGIN { exit !(l+0 <= 20) }' || { echo "ABORT: load ${load1} > 20" >&2; exit 2; }
# the app's CLAUDE_CONFIG_DIR is a SCRATCH dir — never a live ~/.claude* (app boot's account-inherit sync strips whatever dir it is handed)
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${REPO}/scripts/e2e-contained-rig.sh" node --no-warnings --experimental-strip-types "${HERE}/e2e-pause-ui.mjs" "${ARGS[@]}" --live-home "${HOME}" "$@"
