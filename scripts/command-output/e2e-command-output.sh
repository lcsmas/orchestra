#!/usr/bin/env bash
# #341 — drive built-in command output (`/recap` …) on a BUILT Orchestra: its OWN headless sway (scripts/e2e-contained-rig.sh: marker-verified, `env -i` allowlist), scratch ORCHESTRA_HOME / HOME /
# CLAUDE_CONFIG_DIR, the REAL `claude` CLI against a LOCAL FAKE Anthropic API, ALL inside bwrap net+pid namespaces (no egress possible; refused outright when bwrap cannot provide them).
# Usage: scripts/command-output/e2e-command-output.sh <app-dir> [--out <dir>] [--label <name>] [--expect fixed|master]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/; `pnpm run build:bundles` and `pnpm run build:bus-abi` first so the app's bus opens).
#   --expect master  the must-FAIL arm: against a build WITHOUT the fix the bubble renders and the output row does NOT.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
[[ $# -ge 1 && "$1" != --* ]] || { echo "usage: $0 <app-dir> [--out <dir>] [--label <name>] [--expect fixed|master]" >&2; exit 2; }
APP="$(cd "$1" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }; shift
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
  [[ -f "${APP}/${f}" ]] || { echo "ABORT: ${APP}/${f} missing — build first (pnpm run build:bundles; pnpm run build:bus-abi)" >&2; exit 2; }
done
CLAUDE="$(command -v claude)" || { echo "ABORT: no \`claude\` on PATH — the rig drives the real CLI" >&2; exit 2; }
CLAUDE="$(realpath "${CLAUDE}")"
BW=(bwrap --dev-bind / / --unshare-net --unshare-pid --proc /proc --die-with-parent)
"${BW[@]}" true 2>/dev/null || { echo "ABORT: bwrap net+pid namespaces unavailable — egress would not be contained" >&2; exit 2; }
# A FRESH base per run: inside the pid namespace the contained rig's `$$` is always 2, so its `e2e64c-$$` dir (and its pid-derived marker colour) would
# be the SAME every run — a leftover dir from the previous run broke the next one (EEXIST). The outer `$$` is unique.
export E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-command-output}/run-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
avail_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"; load1="$(cut -d' ' -f1 /proc/loadavg)"
[[ "${avail_kb}" -ge 6000000 ]] || { echo "ABORT: MemAvailable ${avail_kb} kB < 6 GB" >&2; exit 2; }
awk -v l="${load1}" 'BEGIN { exit !(l+0 <= 20) }' || { echo "ABORT: load ${load1} > 20" >&2; exit 2; }
# the app's CLAUDE_CONFIG_DIR is a SCRATCH dir — never a live ~/.claude* (app boot's account-inherit sync strips whatever dir it is handed)
export CLAUDE_CONFIG_DIR_PIN="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
exec "${BW[@]}" "${REPO}/scripts/e2e-contained-rig.sh" node --no-warnings --experimental-strip-types "${HERE}/e2e-command-output.mjs" "${APP}" --live-home "${HOME}" --claude "${CLAUDE}" --containment netns+pidns "$@"
