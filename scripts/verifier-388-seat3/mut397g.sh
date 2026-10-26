#!/usr/bin/env bash
# Own app-level mutant of the #397 F4 gate: the gate removed from the source, CLEAN rebuild, my arm `internal` through the contained rig (gui-slot), byte-exact restore + cmp, clean rebuild must reproduce the clean md5. Seat 3.
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="/var/tmp/v397s3-$(id -u)"
WT="$TMPDIR/wt-gui"; V="$TMPDIR/v3rig"; G=/var/tmp/orch-1000-b17728/gui-slot.sh; cd "$WT" || exit 90
CLEAN="$(md5sum dist-electron/main.js | cut -c1-12)"; echo "clean main.js md5 $CLEAN (head $(git rev-parse --short=8 HEAD))"
F=src/shared/cdp-proxy-core.ts; cp -p $F "$TMPDIR/m397g-app.orig"
python3 - "$F" <<'PY' || { echo "APPLY FAILED"; exit 91; }
import sys
f=sys.argv[1]; a="if (owner && owner.openedBy !== 'agent' && (await this.navigatesToInternalUrl(st, method, params, childSessionId))) {"; s=open(f).read(); assert s.count(a)==1, s.count(a); open(f,'w').write(s.replace(a,"if (false) {")); print("  APPLIED (F4 gate removed, 1 occurrence)")
PY
rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/m397g-build.log" 2>&1 || { echo BUILD FAILED; cp -p "$TMPDIR/m397g-app.orig" $F; exit 92; }
cp -p "$TMPDIR/m397g-app.orig" $F; cmp -s "$TMPDIR/m397g-app.orig" $F && git diff --quiet -- $F && echo "  restored byte-exact (cmp + git diff clean)" || echo "  RESTORE NOT BYTE-EXACT"
echo "  mutant main.js md5 $(md5sum dist-electron/main.js | cut -c1-12) (clean $CLEAN) chunks $(cat dist-electron/index-*.js | md5sum | cut -c1-12)"
bash "$V/g10wrap.sh" g397g-mutant -- "$G" bash scripts/v3-agent-tabs-drive.sh "$WT" --arm internal --out "$V/runs/g397-out/mutant" --label g397g-mut 2>&1 | grep -E "^G10" | cut -c1-120
grep -E "^  (FAIL|PASS)  \[internal\]|VERDICT" "$V/runs/g397g-mutant.log" | grep -E "FAIL|VERDICT" | cut -c1-240 | head -30
echo "=== CLEAN REBUILD"; rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/m397g-build.log" 2>&1; nice -n 10 pnpm run build:bus-abi > /dev/null 2>&1; echo "  main.js md5 $(md5sum dist-electron/main.js | cut -c1-12) (clean $CLEAN) $([ "$(md5sum dist-electron/main.js | cut -c1-12)" = "$CLEAN" ] && echo REPRODUCES || echo MISMATCH)"; git status --porcelain | grep -v '^??' | cat; echo ALLDONE
