#!/usr/bin/env bash
# N3 (decideCloseThroughCli checks only the FIRST named ref) as a CLI-BUNDLE mutant, driven through MY routes arm. Byte-exact backup/restore + cmp; marker-less (own script).
set -uo pipefail
export V3_FREEZE_LIFTED=1 RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="/var/tmp/v397s3-$(id -u)"
WT="$TMPDIR/wt-gui"; V="$TMPDIR/v3rig"; F="$WT/dist-electron/cli.js"; BK="$TMPDIR/cli.js.n3.orig"
cd "$WT" || exit 90
cp -p "$F" "$BK"; SHA0=$(sha256sum "$F" | cut -d' ' -f1)
restore() { cp -p "$BK" "$F"; cmp -s "$BK" "$F" && [[ "$(sha256sum "$F" | cut -d' ' -f1)" == "$SHA0" ]] && echo "RESTORED byte-exact (cmp OK, sha256 ${SHA0:0:12})" || echo "RESTORE NOT BYTE-EXACT"; }
trap restore EXIT
python3 - "$F" <<'PY' || { echo "APPLY FAILED"; exit 91; }
import sys
f=sys.argv[1]; s=open(f).read()
old="const targets = named.length > 0 ? named : [resolveAbTab(abTabs, void 0)]"; new="const targets = named.length > 0 ? named.slice(0, 1) : [resolveAbTab(abTabs, void 0)]"
assert s.count(old)==1, s.count(old)
open(f,'w').write(s.replace(old,new)); print('APPLIED N3 (1 occurrence)')
PY
echo "MUTANT cli.js sha256 ${F##*/}: $(sha256sum "$F" | cut -c1-12) (orig ${SHA0:0:12})"
bash "$V/g10wrap.sh" n3gui -- /var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/v3-agent-tabs-drive.sh "$WT" --arm routes --out "$V/runs/n3gui-out" 2>&1 | grep -E "^G10" | cut -c1-200
grep -E "FAIL  |VERDICT" "$V/runs/n3gui.log" | cut -c1-330
