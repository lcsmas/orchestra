#!/usr/bin/env bash
# Own app-level mutants of the #396 F1 FIX (gate of 15bfbfba), driven through MY hostile-page drive (arm f1[,xdg]), one gui-slot rig run each. Source patched in place
# (each string live exactly once), CLEAN rebuild per mutant, byte-exact restore + cmp BEFORE the rig runs, final clean rebuild must reproduce the clean main.js md5. Seat 3.
#   ONLY="M7 M9" bash mut396f.sh   → run just those
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="/var/tmp/p396s3-$(id -u)"
WT="$TMPDIR/wt-gui"; V="$TMPDIR/v3rig"; G=/var/tmp/orch-1000-b17728/gui-slot.sh; cd "$WT" || exit 90
CLEAN_MAIN="$(md5sum dist-electron/main.js | cut -c1-12)"; echo "clean main.js md5 $CLEAN_MAIN (head $(git rev-parse --short=8 HEAD) tree $(git rev-parse HEAD^{tree} | cut -c1-8))"
run() { # name arms spec.json  (files named in the spec are backed up first and restored byte-exact)
  local name="$1" arms="$2" spec="$3"
  [[ -n "${ONLY:-}" && " $ONLY " != *" ${name%%-*} "* ]] && return
  echo "=== OWN MUTANT $name (arms $arms)"
  local files; files=$(python3 -c "import json,sys; print(' '.join(sorted({e[0] for e in json.load(open(sys.argv[1]))})))" "$spec")
  for f in $files; do cp -p "$f" "$TMPDIR/own396f.$(basename "$f").orig"; done
  restore_all() { for f in $files; do cp -p "$TMPDIR/own396f.$(basename "$f").orig" "$f"; cmp -s "$TMPDIR/own396f.$(basename "$f").orig" "$f" && git diff --quiet -- "$f" && echo "  restored byte-exact (cmp + git diff clean): $f" || echo "  RESTORE NOT BYTE-EXACT: $f"; done; }
  python3 "$TMPDIR/gen396f/mutapply.py" "$spec" || { restore_all; return; }
  rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/own396f-build.log" 2>&1 || { echo "  BUILD FAILED"; tail -3 "$TMPDIR/own396f-build.log"; restore_all; return; }
  restore_all
  local mh; mh="$(md5sum dist-electron/main.js | cut -c1-12)"; echo "  mutant bundle main.js md5 $mh (clean $CLEAN_MAIN) chunks $(cat dist-electron/index-*.js | md5sum | cut -c1-12) $([[ "$mh" != "$CLEAN_MAIN" ]] && echo DIFFERS || echo 'SAME-AS-CLEAN (STALE?)')"
  bash "$V/g10wrap.sh" "f396-mut-$name" -- "$G" bash scripts/v3-popups-drive.sh "$WT" --arms "$arms" --out "$V/runs/f396-out/$name" 2>&1 | grep -E "^G10" | cut -c1-160
  grep -E "FAIL  |VERDICT" "$V/runs/f396-mut-$name.log" | cut -c1-300 | head -14
}
J=$TMPDIR/gen396f
BP=src/main/browser-panel.ts; POP=src/main/browser-popups.ts
cat > $J/m7.json <<'JS'
[["src/main/browser-panel.ts", "    const d = decideExternalProtocol({ url, userGesture });", "    const d: { allow: boolean; reason?: string } = { allow: isOsHandoffUrl(url) };"]]
JS
cat > $J/m8.json <<'JS'
[["src/main/browser-popups.ts", "  lastActivation.delete(wc);\n  return now - at <= USER_GESTURE_WINDOW_MS;", "  return now - at <= USER_GESTURE_WINDOW_MS;"]]
JS
cat > $J/m9.json <<'JS'
[["src/main/browser-panel.ts", "const userGesture = isOsHandoffUrl(url) && !!wc && consumeUserGesture(wc);", "const userGesture = !!wc && consumeUserGesture(wc);"]]
JS
cat > $J/m10.json <<'JS'
[["src/main/browser-popups.ts", "const lastActivation = new WeakMap<WebContents, number>();", "const lastActivation = new WeakMap<WebContents, number>();\nconst ANYWC = {} as WebContents;"],
 ["src/main/browser-popups.ts", "if (ACTIVATING_INPUT.has(input.type)) lastActivation.set(wc, now());", "if (ACTIVATING_INPUT.has(input.type)) lastActivation.set(ANYWC, now());"],
 ["src/main/browser-popups.ts", "const at = lastActivation.get(wc);", "const at = lastActivation.get(ANYWC);"],
 ["src/main/browser-popups.ts", "  lastActivation.delete(wc);\n  return now - at <= USER_GESTURE_WINDOW_MS;", "  lastActivation.delete(ANYWC);\n  return now - at <= USER_GESTURE_WINDOW_MS;"]]
JS
run M7-fix-reverted-scheme-only-handler f1,xdg $J/m7.json
run M8-gesture-never-consumed f1 $J/m8.json
run M9-refused-scheme-eats-the-activation f1 $J/m9.json
run M10-gesture-is-global-not-per-contents f1 $J/m10.json
echo "=== FINAL CLEAN REBUILD"; rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/own396f-build.log" 2>&1; echo "  build RC=$? main.js md5 $(md5sum dist-electron/main.js | cut -c1-12) (clean $CLEAN_MAIN) $([ "$(md5sum dist-electron/main.js | cut -c1-12)" = "$CLEAN_MAIN" ] && echo REPRODUCES || echo MISMATCH)"
git status --porcelain | grep -v '^??' | cat; echo ALLDONE
