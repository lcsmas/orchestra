#!/usr/bin/env bash
# #323 (D-Q10 A+A) — drive the Plafond mémoire UI (window levels + refusal + the next member's scope + the Resources bar) on a BUILT Orchestra under its OWN headless sway (scripts/e2e-contained-rig.sh: marker-verified,
# `env -i` allowlist), scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, REAL keepers in REAL disposable user scopes named `orchestra-rig-wh-h2c-*` (hard level typed down to 0.25 GB: ≤ 300 MB, D2), a stub `claude`.
# Driver: scripts/memcap-settings/e2e-memcap-settings.mjs. HEAVY (a built app under a compositor + real scopes): needs the §Roster heavy-rig token + MemAvailable > 6 GB; the app and every rig scope are stopped by identity / by name and survivors printed.
# Usage: scripts/memcap-settings/e2e-memcap-settings.sh <app-dir | --packaged <bin>> [--out <dir>] [--label <name>] [--expect-red]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
[[ $# -ge 1 ]] || { echo "usage: $0 <app-dir | --packaged <bin>> [--out <dir>] [--label <name>] [--expect-red]" >&2; exit 2; }
if [[ "$1" == "--packaged" ]]; then
  APP="$2"; [[ -x "${APP}" ]] || { echo "ABORT: ${APP} is not executable" >&2; exit 2; }
  ARGS=(--packaged "$(realpath "${APP}")"); shift 2
else
  APP="$(cd "$1" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
  for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
    [[ -f "${APP}/${f}" ]] || { echo "ABORT: ${APP}/${f} missing — build first (pnpm run build:bus-abi; pnpm run build:bundles)" >&2; exit 2; }
  done
  ARGS=("${APP}"); shift
fi
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-memcap-settings}"
mkdir -p "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
avail_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"; load1="$(cut -d' ' -f1 /proc/loadavg)"
[[ "${avail_kb}" -ge 6000000 ]] || { echo "ABORT: MemAvailable ${avail_kb} kB < 6 GB" >&2; exit 2; }
awk -v l="${load1}" 'BEGIN { exit !(l+0 <= 20) }' || { echo "ABORT: load ${load1} > 20" >&2; exit 2; }
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${REPO}/scripts/e2e-contained-rig.sh" node --no-warnings --experimental-strip-types "${HERE}/e2e-memcap-settings.mjs" "${ARGS[@]}" --live-home "${HOME}" "$@"
