#!/usr/bin/env bash
# Built-app E2E for #390 (pinned Node for the keepers): drives the shipped AppImage in its OWN headless sway (scripts/e2e-contained-rig.sh).
# Usage: scripts/e2e-pinned-node-app.sh [<Orchestra.AppImage>]   (default release/Orchestra.AppImage — `pnpm run build` first)
# Driver + phases: scripts/e2e-pinned-node-app.mjs. One Electron at a time, nice 10, refuses below 6 GB MemAvailable.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
[[ "${avail_kb}" -ge 6000000 ]] || { echo "ABORT: MemAvailable ${avail_kb} kB < 6 GB (the machine runs ~20 agents)" >&2; exit 2; }
# SHORT on purpose: the keeper socket lives at <rig base>/e2e64c-<pid>/oh/<boot>/keepers/<ws>.sock and a path past 100 chars falls back to a shared /tmp socket.
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/pn390-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not a directory owned by me" >&2; exit 2; }
chmod 700 "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base is on tmpfs" >&2; exit 2; }
# The invoker's live config dir is only ever PROTECTED (hashed before/after), never used as the app's account.
export CLAUDE_CONFIG_DIR_PIN="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
exec nice -n 10 "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-pinned-node-app.mjs" "$@"
