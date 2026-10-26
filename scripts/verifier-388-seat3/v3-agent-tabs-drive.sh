#!/usr/bin/env bash
# seat 3 launcher for the #397 own drive: same containment as scripts/e2e-browser-agent-tabs.sh (private runtime world via e2e-contained-rig.sh), my driver.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${1:?usage: $0 <app-dir> [--arm a,b]}" && pwd)"; shift
for f in package.json dist/index.html dist-electron/main.js dist-electron/cli.js dist-electron/keeper.js build/agent-browser/agent-browser; do [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing" >&2; exit 2; }; done
[[ "$(awk '/MemAvailable/ {print $2}' /proc/meminfo)" -ge 6000000 ]] || { echo "ABORT: MemAvailable < 6 GB" >&2; exit 2; }
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/v397s3-$(id -u)}"; mkdir -p -m 700 "${E2E_RIG_BASE}"; chmod 700 "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != tmpfs ]] || { echo "ABORT: rig base on tmpfs" >&2; exit 2; }
export CLAUDE_CONFIG_DIR_PIN="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
exec nice -n 10 "${HERE}/e2e-contained-rig.sh" node --experimental-strip-types "${HERE}/v3-agent-tabs-drive.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
