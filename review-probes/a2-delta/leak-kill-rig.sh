#!/bin/bash
# Abnormal-termination leak probe: SIGTERM the rig (what execFile's 240 s timeout does) while a keeper is SIGSTOPped.
ARM=${1:-kill_hung_keeper}
export HOME=/home/lmas/rd TMPDIR=/home/lmas/rd/tmp
export A2_HOME=/home/lmas/rd/.a2-rig/L$$
TIP=/home/lmas/.orchestra/worktrees/orchestra-silent-beetle-2c058ab8
cd $TIP
/usr/bin/node --experimental-strip-types --import $TIP/scripts/.r2-register.mjs scripts/e2e-keeper-lifecycle.mjs $ARM > /home/lmas/rev-a2-delta/leak-rig-$ARM.out 2>/dev/null &
RIG=$!
echo "rig pid=$RIG arm=$ARM"
found=""
for i in $(seq 1 400); do
  found=$(ps -eo pid,stat,args | awk -v d="a2-rig/L$$" '$2 ~ /^T/ && index($0,d) {print $1}' | head -1)
  [ -n "$found" ] && break
  sleep 0.1
done
if [ -z "$found" ]; then echo "NEVER SAW A STOPPED KEEPER — probe VOID"; kill -9 $RIG 2>/dev/null; exit 3; fi
echo "saw SIGSTOPped process pid=$found; SIGTERM the rig now"
kill -TERM $RIG
wait $RIG 2>/dev/null; echo "rig exit rc=$?"
sleep 1.5
LEFT=$(ps -eo pid,ppid,stat,etimes,args | grep -F "a2-rig/L$$" | grep -v grep)
echo "LEFTOVER COUNT after rig SIGTERM: $(echo -n "$LEFT" | grep -c .)"
echo "$LEFT" | cut -c1-170
# cleanup (mine): SIGKILL exactly those pids, then assert 0
for p in $(echo "$LEFT" | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
sleep 1
echo "after my cleanup: $(ps -eo args | grep -F "a2-rig/L$$" | grep -vc grep)"
rm -rf /home/lmas/rd/.a2-rig/L$$
