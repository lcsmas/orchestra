#!/usr/bin/env bash
# mut393.sh — clean control drive, then the own built-app mutants (seat 3). Run from the candidate tree. Each mutant: verified-live string, rebuild from clean dist, drive, byte-exact restore.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT" || exit 90; V="$TMPDIR/v3rig"; M="$V/mut"
echo "CLEAN-FINGERPRINT main.js=$(md5sum dist-electron/main.js | cut -c1-12) renderer=$(cat dist/assets/index-*.js | md5sum | cut -c1-12)"
echo "=== CONTROL (unmutated candidate, fixed driver)"; bash "$V/rigrun.sh" ctl-drive2 "$ROOT" "$V/tabs-drive.mjs" cand all 2>&1 | grep -E "^(FAIL|RIG-RESULT|G10|RIGRUN)" | cut -c1-300
run() { # name file arms
  local name="$1" file="$2" arms="$3"
  echo "=== MUTANT $name ($file, arms=$arms)"
  MUT_TAIL=60 bash "$V/mut.sh" "$name" "$file" "$M/$name.old" "$M/$name.new" -- bash "$V/drivemut393.sh" "$name" "$arms" 2>&1 | grep -E "^(APPLY|MUTANT-DIFF|BUILT|FAIL|RIG-RESULT|G10|RIGRUN|MUTANT-RESULT|BUILD)" | cut -c1-300
}
run A1-quit-does-not-flush src/main/index.ts restart
run A2-close-button-click-bubbles src/renderer/components/BrowserPanel.tsx x
run A3-human-closes-as-agent src/main/api-handlers.ts x
run A8-refusal-notice-swallowed src/renderer/components/BrowserPanel.tsx cap
run A9-design-not-disarmed-on-tab-change src/renderer/components/BrowserPanel.tsx design
run A10-destroy-keeps-saved-tabs src/main/browser-panel.ts restart,archive
run A7-strip-not-keyed-per-workspace src/renderer/App.tsx x
echo "=== FINAL CLEAN REBUILD"; rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/final-clean-build.log" 2>&1; echo "clean rebuild RC=$?"; nice -n 10 pnpm run build:bus-abi >/dev/null 2>&1; echo "CLEAN-FINGERPRINT-AFTER main.js=$(md5sum dist-electron/main.js | cut -c1-12) renderer=$(cat dist/assets/index-*.js | md5sum | cut -c1-12)"
git status --porcelain | head -5; echo "porcelain-lines=$(git status --porcelain | wc -l)"
