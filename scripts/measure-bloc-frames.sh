#!/usr/bin/env bash
# #419 — live Bloc HTML cost (memory of N live frames, idle vs busy, sibling freeze) in the BUILT app, contained rig. Driver: scripts/measure-bloc-frames.mjs.
# Usage: scripts/measure-bloc-frames.sh <app-dir> --plan <runs.jsonl> [--evidence <file.jsonl>] [--out <dir>] [--settle s] [--window s]
#   <app-dir> a BUILT checkout (dist/ + dist-electron/ + node_modules/electron). Resumable: ids already in --evidence are skipped.
# No-rig summary: node scripts/measure-bloc-frames.mjs --summary docs/evidence/419-bloc-frame-cost.jsonl
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> --plan <runs.jsonl> [--evidence f] [--out dir]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js node_modules/electron/dist/electron; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles)" >&2; exit 2; }
done
AVAIL_KB="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
(( AVAIL_KB >= 6*1024*1024 )) || { echo "ABORT: MemAvailable ${AVAIL_KB} kB < 6 GB (a measurement must never trip the fleet's memory guard)" >&2; exit 2; }
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/bf-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not a directory owned by me (or is a symlink)" >&2; exit 2; }
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/measure-bloc-frames.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
