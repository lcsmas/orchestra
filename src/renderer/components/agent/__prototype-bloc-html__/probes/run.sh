#!/usr/bin/env bash
# PROTOTYPE — throwaway. Runs probes/main.cjs in a bare Electron (never the Orchestra app) inside the repo's
# contained rig: its own marker-verified headless sway, env -i allowlist, private XDG_RUNTIME_DIR, and the
# human's /run/user/<uid> hidden (bwrap). No window can reach the human's screen.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../../.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:?TMPDIR unset}/bloc-html-probes.XXXXXX")"
echo "scratch: $scratch"
E2E_RIG_BASE="$TMPDIR" RIG_HIDE_REAL_RUNTIME=1 "$repo/scripts/e2e-contained-rig.sh" \
  "$repo/node_modules/.bin/electron" --ozone-platform=wayland "$here/main.cjs" "--scratch=$scratch" \
  >"$scratch/stdout.log" 2>"$scratch/stderr.log" || echo "rig exit code: $?"
grep -a '^PROBE_' "$scratch/stdout.log" "$scratch/stderr.log" || { echo "NO PROBE OUTPUT — stderr tail:"; grep -a -v 'bus.cc' "$scratch/stderr.log" | tail -25; exit 1; }
echo "result: $scratch/result.json"
