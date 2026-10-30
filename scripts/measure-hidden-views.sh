#!/usr/bin/env bash
# #406 — hidden-view COST measurement (arms A0/A1/A2 × pages P-idle/P-busy/P-heavy × N hidden views) in the contained rig.
# Usage: nice -n 10 /var/tmp/orch-1000-b17728/gui-slot.sh scripts/measure-hidden-views.sh <repo-dir> --stage main|n160|a2 [--batch-min 40] [--out dir] [--dev]
#   <repo-dir> a checkout with node_modules (the pinned Electron is read from there; no app build needed). Resumable: re-run the same command.
#   First run of a new tree: RIG_HIDE_REAL_RUNTIME=1 (the real runtime dir becomes an empty tmpfs inside the rig).
# No-rig modes (any shell): node --experimental-strip-types scripts/measure-hidden-views.mjs --verdict docs/evidence/406-hidden-view-cost.jsonl
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:-}"
[[ -n "${REPO}" && "${REPO}" != --* ]] || { echo "usage: $0 <repo-dir> --stage main|n160|a2 [--batch-min 40] [--out dir] [--dev]" >&2; exit 2; }
shift
REPO="$(cd "${REPO}" 2>/dev/null && pwd)" || { echo "ABORT: repo dir does not exist" >&2; exit 2; }
[[ -x "${REPO}/node_modules/electron/dist/electron" ]] || { echo "ABORT: ${REPO}/node_modules/electron missing — pnpm install --frozen-lockfile" >&2; exit 2; }
AVAIL_KB="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
(( AVAIL_KB >= 8*1024*1024 )) || { echo "ABORT: MemAvailable ${AVAIL_KB} kB < 8 GB (the #406 memory-safety floor: a measurement must never trip the fleet's guard)" >&2; exit 2; }
export E2E_RIG_BASE="${E2E_RIG_BASE:-${TMPDIR:-/var/tmp}/measure-rig}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
# the rig's `env -i` strips TMPDIR: hand the scratch OUT dir over as a CLI flag so nothing lands in a new path outside $TMPDIR
OUT_ARGS=()
if [[ " $* " != *" --out "* ]]; then
  if [[ " $* " == *" --dev "* ]]; then OUT_ARGS=(--out "${TMPDIR:-/var/tmp}/measure-406-dev"); else OUT_ARGS=(--out "${TMPDIR:-/var/tmp}/measure-406"); fi
fi
exec "${HERE}/e2e-contained-rig.sh" node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning "${HERE}/measure-hidden-views.mjs" "${REPO}" "$@" "${OUT_ARGS[@]}"
