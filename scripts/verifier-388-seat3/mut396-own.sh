#!/usr/bin/env bash
# Own app-level mutants of #396 driven through MY hostile-page drive (6 mutants, one gui-slot rig run each). Source patched in place (string live exactly once),
# CLEAN rebuild per mutant (rm dist*), byte-exact restore + cmp, final clean rebuild must reproduce the clean main.js md5. Seat 3.
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="/var/tmp/p396s3-$(id -u)"
WT="$TMPDIR/wt-gui"; V="$TMPDIR/v3rig"; G=/var/tmp/orch-1000-b17728/gui-slot.sh; cd "$WT" || exit 90
CLEAN_MAIN="$(md5sum dist-electron/main.js | cut -c1-12)"; echo "clean main.js md5 $CLEAN_MAIN (head $(git rev-parse --short=8 HEAD))"
bk() { cp -p "$1" "$TMPDIR/own396.$(basename "$1").orig"; }
restore() { f="$1"; cp -p "$TMPDIR/own396.$(basename "$f").orig" "$f"; cmp -s "$TMPDIR/own396.$(basename "$f").orig" "$f" && git diff --quiet -- "$f" && echo "  restored byte-exact (cmp + git diff clean): $f" || echo "  RESTORE NOT BYTE-EXACT: $f"; }
run() { # name file arms from to
  local name="$1" file="$2" arms="$3"; local from="$4" to="$5"
  [[ -n "${ONLY:-}" && " $ONLY " != *" ${name%%-*} "* ]] && return
  echo "=== OWN MUTANT $name ($file → arms $arms)"
  bk "$file"
  python3 - "$file" "$from" "$to" <<'PY' || { echo "  APPLY FAILED (string not live exactly once)"; restore "$file"; return; }
import sys
f,old,new=sys.argv[1:4]; s=open(f).read(); n=s.count(old)
assert n==1, f"occurs {n}x"
open(f,'w').write(s.replace(old,new)); print("  APPLIED (1 occurrence)")
PY
  rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/own396-build.log" 2>&1 || { echo "  BUILD FAILED"; tail -3 "$TMPDIR/own396-build.log"; restore "$file"; return; }
  restore "$file"   # sources restored BEFORE the rig runs: the built bundle is what is under test
  echo "  mutant bundle main.js md5 $(md5sum dist-electron/main.js | cut -c1-12) (clean $CLEAN_MAIN) chunks $(cat dist-electron/index-*.js | md5sum | cut -c1-12)"
  bash "$V/g10wrap.sh" "own396-mut-$name" -- "$G" bash scripts/v3-popups-drive.sh "$WT" --arms "$arms" --out "$V/runs/own396-mut-out/$name" 2>&1 | grep -E "^G10" | cut -c1-160
  grep -E "FAIL  |VERDICT" "$V/runs/own396-mut-$name.log" | cut -c1-330 | head -8
}
BP=src/main/browser-panel.ts; POP=src/main/browser-popups.ts; POL=src/shared/browser-tab-policy.ts; BPW=src/shared/browser-popup-window.ts
run M1-external-permission-always-granted $BP xdg "    callback(ok);
  });" "    callback(true);
  });"
run M2-page-resize-not-vetoed $BP resize "  wc.on('content-bounds-updated', (e) => e.preventDefault());
" ""
run M3-page-may-retitle-the-window $BP title "    e.preventDefault(); // the title is ours: the origin first, so a page cannot dress its window up as someone else
" ""
run M4-frame-name-never-held-by-another $POP names "  if (name === '') return false;
  for (const wsId of [...windows.keys()]) {" "  if (name === '') return false;
  return false;
  for (const wsId of [...windows.keys()]) {"
run M5-rate-cap-ignored $POL storm "if (!req.userGesture && (ctx.recentPageInitiated ?? 0) >= rateMax) {" "if (false) {"
run M6-parent-share-100pct $BPW resize "export const POPUP_WINDOW_PARENT_SHARE = 0.9;" "export const POPUP_WINDOW_PARENT_SHARE = 1;"
echo "=== FINAL CLEAN REBUILD"; rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/own396-build.log" 2>&1; echo "  build RC=$? main.js md5 $(md5sum dist-electron/main.js | cut -c1-12) (clean $CLEAN_MAIN) $([ "$(md5sum dist-electron/main.js | cut -c1-12)" = "$CLEAN_MAIN" ] && echo MATCH || echo DIFFERS)"; nice -n 10 pnpm run build:bus-abi > /dev/null 2>&1; echo "  bus-abi RC=$?"
git status --porcelain | cat; echo ALLDONE
