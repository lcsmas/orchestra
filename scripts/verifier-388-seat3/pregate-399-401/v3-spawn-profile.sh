#!/usr/bin/env bash
# #401 — `orchestra spawn --profile` end-to-end on a BUILT Orchestra under its OWN headless sway (scripts/e2e-contained-rig.sh, `env -i`
# allowlist), the real claude CLI against a LOCAL FAKE Anthropic API. Driver: scripts/v3-spawn-profile-drive.mjs.
# Usage: scripts/e2e-spawn-profile.sh <app-dir> [--arms a1,a2,…] [--out <dir>]   (build first: pnpm run build:bundles && pnpm run build:bus-abi)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--arms …] [--out <dir>]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" && pwd)"
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js dist-electron/cli.js scripts/fixtures/browser-site/server.mjs; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — pnpm run build:bundles first" >&2; exit 2; }
done
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/avr-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} not mine" >&2; exit 2; }
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base on tmpfs" >&2; exit 2; }
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/v3-spawn-profile-drive.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
