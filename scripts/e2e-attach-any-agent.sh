#!/usr/bin/env bash
# #439 — built-app drive: attach / detach under ANY agent (sidebar drag-and-drop + the built CLI) in a contained rig (own headless sway,
# private runtime dir, scratch ORCHESTRA_HOME + scratch config dir). Usage: scripts/e2e-attach-any-agent.sh <app-dir>   (build first: pnpm run build:bundles)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" ]] || { echo "usage: $0 <app-dir>" >&2; exit 2; }
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js dist-electron/cli.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — pnpm run build:bundles first" >&2; exit 2; }
done
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/a439-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not mine" >&2; exit 2; }
export CLAUDE_CONFIG_DIR_PIN="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"   # forwarded as the child's CLAUDE_CONFIG_DIR; the driver never uses it as the account
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-attach-any-agent.mjs" "${APP_DIR}"
