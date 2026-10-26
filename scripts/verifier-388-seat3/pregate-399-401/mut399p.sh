#!/usr/bin/env bash
# Own app-level mutants of #400's profile policy, driven through the member's `skill-profile` arm and my `v3prof` arm: a sentence of the skill's profile section made FALSE in the product. Seat 3.
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="/var/tmp/p399s3-$(id -u)"
WT="$TMPDIR/wt-gui399"; V="$TMPDIR/v3rig"; G=/var/tmp/orch-1000-b17728/gui-slot.sh; cd "$WT" || exit 90
CLEAN="$(md5sum dist-electron/main.js | cut -c1-12)"; echo "clean main.js md5 $CLEAN (head $(git rev-parse --short=8 HEAD))"
F=src/shared/browser-profile.ts
run() { # name from to
  echo "=== OWN MUTANT $1"; cp -p $F "$TMPDIR/m399p.orig"
  python3 - "$F" "$2" "$3" <<'PY' || { echo "  APPLY FAILED"; cp -p "$TMPDIR/m399p.orig" $F; return; }
import sys
f,a,b=sys.argv[1:4]; s=open(f).read(); assert s.count(a)==1, s.count(a); open(f,'w').write(s.replace(a,b)); print("  APPLIED (1 occurrence)")
PY
  rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/m399p-build.log" 2>&1 || { echo "  BUILD FAILED"; cp -p "$TMPDIR/m399p.orig" $F; return; }
  cp -p "$TMPDIR/m399p.orig" $F; cmp -s "$TMPDIR/m399p.orig" $F && git diff --quiet -- $F && echo "  restored byte-exact (cmp + git diff clean)" || echo "  RESTORE NOT BYTE-EXACT"
  echo "  mutant main.js md5 $(md5sum dist-electron/main.js | cut -c1-12) (clean $CLEAN)"
  bash "$V/g10wrap.sh" "m399p-$1-member" -- "$G" bash scripts/e2e-browser-cli-parity.sh "$WT" --arm skill-profile --out "$V/runs/f399-out/mp-$1-m" 2>&1 | grep -E "^G10 " | cut -c1-60
  grep -E "^  FAIL|^VERDICT" "$V/runs/m399p-$1-member.log" | cut -c1-230 | head -8
  bash "$V/g10wrap.sh" "m399p-$1-mine" -- "$G" bash scripts/v3-skill-claims.sh "$WT" --arm v3prof --out "$V/runs/f399-out/mp-$1-v" 2>&1 | grep -E "^G10 " | cut -c1-60
  grep -E "^  FAIL  \[v3prof\]" "$V/runs/m399p-$1-mine.log" | sed -E 's/ — .*//' | cut -c1-200 | head -10
}
run P1-refused-methods-lookup-disabled "const kind = PROFILE_REFUSED_CDP_METHODS.get(input.method);" "const kind = undefined as 'clear' | 'read' | undefined;"
run P2-site-scope-disabled "if (targets === null || targets.some((t) => !isPageSite(input.pageUrl, t))) return { ok: false, message: REFUSAL_SITE };" "if (false) return { ok: false, message: REFUSAL_SITE };"
echo "=== CLEAN REBUILD"; rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$TMPDIR/m399p-build.log" 2>&1; nice -n 10 pnpm run build:bus-abi > /dev/null 2>&1; echo "  main.js md5 $(md5sum dist-electron/main.js | cut -c1-12) (clean $CLEAN) $([ "$(md5sum dist-electron/main.js | cut -c1-12)" = "$CLEAN" ] && echo REPRODUCES || echo MISMATCH)"; git status --porcelain | grep -v '^??' | cat; echo ALLDONE
