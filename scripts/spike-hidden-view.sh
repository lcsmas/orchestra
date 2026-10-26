#!/usr/bin/env bash
# #402 — hidden-view spike on Electron 33 under sway, inside the contained rig (own headless sway, scratch HOME).
# Usage: scripts/spike-hidden-view.sh <repo-dir> [--arms a,b,…|all] [--n 5] [--window 8] [--out dir]
#   <repo-dir> a checkout with node_modules (the pinned Electron is read from there; no app build needed).
# Prints the matrix; JSON in <out>/matrix.json. Re-run: nice -n 10 scripts/spike-hidden-view.sh "$PWD" --n 5
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:-}"
[[ -n "${REPO}" && "${REPO}" != --* ]] || { echo "usage: $0 <repo-dir> [--arms a,b|all] [--n 5] [--window 8] [--out dir]" >&2; exit 2; }
shift
REPO="$(cd "${REPO}" 2>/dev/null && pwd)" || { echo "ABORT: repo dir does not exist" >&2; exit 2; }
[[ -x "${REPO}/node_modules/electron/dist/electron" ]] || { echo "ABORT: ${REPO}/node_modules/electron missing — pnpm install --frozen-lockfile" >&2; exit 2; }
AVAIL_KB="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
(( AVAIL_KB >= 6*1024*1024 )) || { echo "ABORT: MemAvailable ${AVAIL_KB} kB < 6 GB (fleet rig bound)" >&2; exit 2; }
export E2E_RIG_BASE="${E2E_RIG_BASE:-${TMPDIR:-/var/tmp}/spike-rig}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/spike-hidden-view.mjs" "${REPO}" "$@"
