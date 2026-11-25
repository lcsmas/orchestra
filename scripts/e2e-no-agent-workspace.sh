#!/usr/bin/env bash
# #612 — the NO-AGENT workspace on a BUILT Orchestra, in the contained rig (own headless sway, private runtime dir, env allowlist, scratch ORCHESTRA_HOME + scratch
# account dir) with the real claude CLI against a LOCAL FAKE Anthropic API (zero tokens; a `model` request = an agent turn). Driver: scripts/e2e-no-agent-workspace.mjs.
# Usage: scripts/e2e-no-agent-workspace.sh <app-dir> [--soak <seconds>] [--out <dir>]   (build first: pnpm run build:bundles && pnpm run build:bus-abi)
# Mutants (built-bundle text patches, one rig run each): node scripts/no-agent-workspace-mutants.mjs <app-dir>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--soak <s>] [--out <dir>]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" && pwd)"
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js dist-electron/cli.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — pnpm run build:bundles first" >&2; exit 2; }
done
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-no-agent-612}"
mkdir -p "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base on tmpfs" >&2; exit 2; }
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-no-agent-workspace.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
