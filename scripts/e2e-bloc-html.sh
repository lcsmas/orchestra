#!/usr/bin/env bash
# #415 — Bloc HTML isolation rig: boots a BUILT Orchestra under its OWN headless sway (scripts/e2e-contained-rig.sh: marker-verified,
# `env -i` allowlist, private XDG), replays a conversation with blocs, and measures what a bloc can reach. Driver: scripts/e2e-bloc-html.mjs.
#
# Usage: scripts/e2e-bloc-html.sh <app-dir> [--arms real,policy,nav,webrtc,sandbox-api,sandbox-loop] [--out <dir>]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/ incl. keeper.js). The `real` arm boots it as is (every clause GREEN);
#              each mutant arm boots a COPY of it with ONE guard removed and must turn exactly its own clause RED.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"
[[ -n "${APP_DIR}" && "${APP_DIR}" != --* ]] || { echo "usage: $0 <app-dir> [--arms real,policy,nav,webrtc,sandbox-api,sandbox-loop] [--out <dir>]" >&2; exit 2; }
shift
APP_DIR="$(cd "${APP_DIR}" 2>/dev/null && pwd)" || { echo "ABORT: app dir does not exist" >&2; exit 2; }
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles)" >&2; exit 2; }
done

# SHORT base on btrfs under /var/tmp (keeper socket paths must stay < 100 chars; never /tmp). Nothing here deletes anything.
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/bh-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not a directory owned by me (or is a symlink)" >&2; exit 2; }
chmod 700 "${E2E_RIG_BASE}"
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be a real disk filesystem" >&2; exit 2; }

# The app's CLAUDE_CONFIG_DIR is a SCRATCH dir — never a live ~/.claude*. `env -i` drops the real HOME, so it travels as an ARGUMENT (the driver snapshots it before/after).
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-bloc-html.mjs" "${APP_DIR}" --live-home "${HOME}" "$@"
