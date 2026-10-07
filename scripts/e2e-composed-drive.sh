#!/usr/bin/env bash
# #294 — the PACKAGED-APP drive of the composed proof (banner + a labelled container stopped by the memory Pause and restarted at the Reprise + the many-container Reprise measurement + #287 keeper-resident wake),
# in its OWN headless sway (scripts/e2e-contained-rig.sh), scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, the REAL Docker daemon (rig-prefixed + labelled containers only; the host's own are asserted unchanged).
# Driver: scripts/e2e-composed-drive.mjs. HEAVY (a packaged app + keepers + Docker under a compositor): needs the OPS' heavy-rig token and MemAvailable > 9 GB right before.
#
# Usage: scripts/e2e-composed-drive.sh --build                 build the PACKAGED app from THIS tree (in a scratch worktree) and print its path
#        scripts/e2e-composed-drive.sh --app <packaged orchestra> [--containers 6] [--ballast-mb 100] [--phases main,resident] [--label g]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
BASE="${E2E_COMPOSED_BASE:-$HOME/.cache/g10d}"          # SHORT on purpose: the keeper's relay socket <H>/keepers/<ws>.docker.sock must stay ≤ 107 bytes
mkdir -p "${BASE}/rigs" "${BASE}/pin-cfg" "${BASE}/apps"

if [[ "${1:-}" == "--build" ]]; then
  # the packaged app = electron-builder --dir over the bundles of THIS tree, built in a scratch worktree at HEAD (never in the caller's tree: it wipes dist/ dist-electron/ release/)
  TREE="${BASE}/app-src"
  git -C "${REPO}" worktree remove --force "${TREE}" 2>/dev/null || true
  rm -rf "${TREE}"
  git -C "${REPO}" worktree add -q --detach "${TREE}" HEAD
  ln -s "${REPO}/node_modules" "${TREE}/node_modules"
  mkdir -p "${TREE}/build" && ln -s "${REPO}/build/bus-abi" "${TREE}/build/bus-abi"
  LIVE="${REPO}/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  EL="$(ls "${REPO}"/build/bus-abi/*abi130.node | head -1)"
  cmp -s "${LIVE}" "${EL}" || { echo "app: node_modules does not hold the Electron-ABI better-sqlite3 — building it (build:bus-abi)"; (cd "${REPO}" && pnpm run build:bus-abi); }
  (cd "${TREE}" && pnpm run build:bundles && npx electron-builder --dir)
  UNP="$(ls -d "${TREE}"/release/*-unpacked | head -1)"
  STAMP="$(git -C "${REPO}" rev-parse --short HEAD)"
  DEST="${BASE}/apps/src-${STAMP}"
  rm -rf "${DEST}"; cp -a --reflink=auto "${UNP}" "${DEST}"
  echo "PACKAGED APP: ${DEST}/orchestra (HEAD ${STAMP}, version $(node -p "require('${REPO}/package.json').version"))"
  exit 0
fi

APP=""; ARGS=()
while [[ $# -gt 0 ]]; do case "$1" in --app) APP="$2"; shift 2;; *) ARGS+=("$1"); shift;; esac; done
[[ -n "${APP}" && -x "${APP}" ]] || { echo "usage: $0 --app <packaged orchestra binary> | --build" >&2; exit 2; }
[[ -f "$(dirname "${APP}")/resources/app.asar" ]] || { echo "ABORT: ${APP} is not a PACKAGED build (no resources/app.asar beside it)" >&2; exit 2; }
CLAUDE="$(command -v claude || true)"; [[ -n "${CLAUDE}" ]] || CLAUDE="$HOME/.local/bin/claude"
[[ -x "${CLAUDE}" ]] || { echo "ABORT: no claude CLI" >&2; exit 2; }
awk '/MemAvailable/{exit !($2 > 9*1048576)}' /proc/meminfo || { echo "ABORT: MemAvailable <= 9 GB — heavy rig refused (wave launch rule)" >&2; exit 2; }
FSTYPE="$(findmnt -no FSTYPE -T "${BASE}")"; [[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: ${BASE} is on tmpfs — must be btrfs under ~" >&2; exit 2; }
export E2E_RIG_BASE="${BASE}/rigs" CLAUDE_CONFIG_DIR_PIN="${BASE}/pin-cfg"
exec "${HERE}/e2e-contained-rig.sh" node --no-warnings --experimental-strip-types "${HERE}/e2e-composed-drive.mjs" --base "${BASE}" --repo "${REPO}" --app "${APP}" --claude "${CLAUDE}" "${ARGS[@]}"
