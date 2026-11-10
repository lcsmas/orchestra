#!/usr/bin/env bash
# #419 — Bloc HTML live-frame budget rig: BUILT app, contained rig (own headless sway, scratch world), a long reply full of blocs scrolled end to end.
# Usage: scripts/e2e-bloc-budget.sh <app-dir> [--arms real,never-unmount,no-placeholder,watchdog-mount] [--out <dir>]
#   `real` must be ALL GREEN; each mutant arm boots a COPY with ONE guard removed and must turn exactly its own clause RED. Driver: scripts/e2e-bloc-budget.mjs.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--arms …] [--out <dir>]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js node_modules/electron/dist/electron; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles)" >&2; exit 2; }
done
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/bb-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not a directory owned by me (or is a symlink)" >&2; exit 2; }
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be a real disk filesystem" >&2; exit 2; }
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-bloc-budget.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
