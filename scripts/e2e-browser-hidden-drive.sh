#!/usr/bin/env bash
# #406 phase 2 — driving a hidden tab/workspace (policy A2, P1–P8) end to end against a BUILT Orchestra under its OWN headless sway
# (scripts/e2e-contained-rig.sh: marker-verified compositor, `env -i` allowlist). Driver + arms + mutants: scripts/e2e-browser-hidden-drive.mjs.
#
# Usage: scripts/e2e-browser-agent-tabs.sh <app-dir> [--arm act,cpu,never,orphan] [--list] [--mutant <name>] [--out <dir>]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/ incl. keeper.js and cli.js) that also holds
#              build/agent-browser/agent-browser (pnpm run fetch:agent-browser). `pnpm run build:bundles` + `pnpm run build:bus-abi` first.
#              MemAvailable >= 8 GB to start (the rig aborts < 6.5 GB), ONE Electron rig at a time.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for a in "$@"; do
  [[ "$a" == "--list" ]] && exec node --experimental-strip-types "${HERE}/e2e-browser-hidden-drive.mjs" --list
done

APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--arm act,cpu,never,orphan] [--list] [--mutant <name>] [--out <dir>]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/cli.js dist-electron/keeper.js build/agent-browser/agent-browser; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — pnpm run build:bundles && pnpm run fetch:agent-browser (and pnpm run build:bus-abi so the app's bus opens)" >&2; exit 2; }
done
MEM_KB="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
[[ "${MEM_KB}" -ge 8000000 ]] || { echo "ABORT: MemAvailable ${MEM_KB} kB < 8 GB — the fleet's memory guard is live; retry later" >&2; exit 2; }

# SHORT btrfs base (a keeper socket path past 100 chars falls back to a shared hashed socket); never tmpfs /tmp.
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/b406-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not a directory owned by me (or is a symlink)" >&2; exit 2; }
chmod 700 "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be a real disk filesystem" >&2; exit 2; }

# The app's account is a SCRATCH dir — never a live ~/.claude* (app boot's account-inherit sync strips whatever dir it is handed).
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
# Foreground, no inner `&`: the contained rig tears its sway down on exit. The real HOME travels as an ARGUMENT (env -i drops it).
exec nice -n 10 "${HERE}/e2e-contained-rig.sh" node --experimental-strip-types "${HERE}/e2e-browser-hidden-drive.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
