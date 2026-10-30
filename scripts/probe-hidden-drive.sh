#!/usr/bin/env bash
# #406 phase 2 design probe (bare Electron, contained rig). Usage: nice -n 10 /var/tmp/orch-1000-b17728/gui-slot.sh scripts/probe-hidden-drive.sh <repo-dir> [--scen A,B,C,D,E] [--flip flip,noflip] [--n 5]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:-}"; [[ -n "${REPO}" && "${REPO}" != --* ]] || { echo "usage: $0 <repo-dir> [...]" >&2; exit 2; }; shift
REPO="$(cd "${REPO}" && pwd)"; [[ -x "${REPO}/node_modules/electron/dist/electron" ]] || { echo "ABORT: electron missing" >&2; exit 2; }
(( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) >= 8*1024*1024 )) || { echo "ABORT: MemAvailable < 8 GB" >&2; exit 2; }
export E2E_RIG_BASE="${E2E_RIG_BASE:-${TMPDIR:-/var/tmp}/measure-rig}"; mkdir -p -m 700 "${E2E_RIG_BASE}"
OUT_ARGS=(); [[ " $* " == *" --out "* ]] || OUT_ARGS=(--out "${TMPDIR:-/var/tmp}/probe-406p2")
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/probe-hidden-drive.mjs" "${REPO}" "$@" "${OUT_ARGS[@]}"
