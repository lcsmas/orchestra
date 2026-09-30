#!/usr/bin/env bash
# UI idle-budget gate (#215 / wave C8): boots a BUILT Orchestra under its OWN headless sway (no visible window), mounts idle
# agent panes and counts per-frame work over a fixed window. Driver + verdict: scripts/e2e-ui-idle-budget.mjs, src/shared/ui-idle-budget.ts.
#
# Usage: scripts/e2e-ui-idle-budget.sh [<app-dir>] [--panes N] [--window-ms N] [--budget file.json] [--json out.json]
#   <app-dir>  a BUILT checkout (package.json + dist/ + dist-electron/); default = this repo. Build first: pnpm run build:bundles
# Exit: 0 PASS · 1 budget breached (names the offender) · 4 REFUSED (a positive control failed) · 90 isolation refusal · 2/3 usage/boot.
# Containment (own sway, marker-verified, `env -i` allowlist, scratch HOME) is e2e-contained-rig.sh's; the app's config dir is a
# SCRATCH dir inside the rig dir — never a live ~/.claude* (app boot runs inheritance sync, which strips a live dir).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${HERE}/.." && pwd)"
if [[ $# -gt 0 && "$1" != --* ]]; then APP_DIR="$(cd "$1" 2>/dev/null && pwd)" || { echo "ABORT: app dir '$1' does not exist" >&2; exit 2; }; shift; fi
for t in sway swaymsg grim python3 node; do
  command -v "$t" >/dev/null 2>&1 || { echo "ABORT: '$t' not found — the UI idle budget needs a headless sway stack (sway swaymsg grim python3 node); the release gate fails closed (bypass: --skip-release-gate \"<reason>\")" >&2; exit 2; }
done
for f in package.json dist/index.html dist-electron/main.js dist-electron/keeper.js; do
  [[ -f "${APP_DIR}/${f}" ]] || { echo "ABORT: ${APP_DIR}/${f} missing — build first (pnpm run build:bundles; a bare 'vite build' omits dist-electron/keeper.js)" >&2; exit 2; }
done

export E2E_RIG_BASE="${E2E_RIG_BASE:-/tmp}"
# `exec` keeps this shell's pid, and e2e-contained-rig.sh names its dir e2e64c-$$ — so the scratch config dir is inside the rig dir
# BEFORE the rig exists. The driver asserts every hand-off path is under RIG_DIR, so a drifted name fails CLOSED (handoff:*:outside-rig-dir).
export CLAUDE_CONFIG_DIR_PIN="${CLAUDE_CONFIG_DIR_PIN:-${E2E_RIG_BASE}/e2e64c-$$/claude-config}"
exec "${HERE}/e2e-contained-rig.sh" node --experimental-strip-types --disable-warning=ExperimentalWarning "${HERE}/e2e-ui-idle-budget.mjs" "${APP_DIR}" "$@"
