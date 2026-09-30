#!/bin/bash
export HOME=/home/lmas/rd TMPDIR=/home/lmas/rd/tmp SUBJECT_REPO=/home/lmas/rev-a2-delta/mt
TIP=/home/lmas/.orchestra/worktrees/orchestra-silent-beetle-2c058ab8
cd $TIP
for arm in stale_two_launch del_bulk_window del_prune_fast kill_spares_successor_files exit_pidless_fallback kill_hung_keeper del_single_survivor kill_keeps_log; do
  export A2_HOME=/home/lmas/rd/.a2-rig/g$$
  line=$(timeout 200 /usr/bin/node --experimental-strip-types --import $TIP/scripts/.r2-register.mjs scripts/e2e-keeper-lifecycle.mjs $arm 2>/dev/null | tail -1)
  echo "$arm => $(echo "$line" | python3 -c 'import sys,json
try:
  j=json.loads(sys.stdin.read()); print("ok="+str(j.get("ok")), "subject="+j.get("subject","?").split("/")[-1], "err="+str(j.get("error",""))[:100])
except Exception as e: print("NOJSON", repr(e)[:60])')"
done
echo "G1 DONE; leftover under rd: $(ps -eo args | grep -F '/home/lmas/rd/' | grep -vc grep)"
