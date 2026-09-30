#!/bin/bash
# Ctrl-C / harness group-kill emulation: SIGTERM the WHOLE process group (wrapper + rigs) while a keeper is SIGSTOPped.
export HOME=/home/lmas/rd TMPDIR=/home/lmas/rd/tmp
TIP=/home/lmas/.orchestra/worktrees/orchestra-silent-beetle-2c058ab8
cd $TIP
setsid /usr/bin/node --test --experimental-strip-types src/main/keeper-lifecycle.test.ts > /home/lmas/rev-a2-delta/group-kill.tap 2>&1 &
W=$!
sleep 0.5
[ "$(ps -o pgid= -p $W | tr -d " ")" = "$W" ] || { echo "GUARD: wrapper is not its own group leader — abort"; kill -TERM $W; exit 4; }
echo "wrapper pid=$W pgid=$(ps -o pgid= -p $W | tr -d ' ')"
found=""
for i in $(seq 1 600); do
  found=$(ps -eo pid,stat,args | awk '$2 ~ /^T/ && index($0,"/home/lmas/rd/.a2-rig/u")' | head -1)
  [ -n "$found" ] && break; sleep 0.1
done
[ -z "$found" ] && { echo "NO STOPPED KEEPER SEEN — VOID"; kill -TERM -$W; exit 3; }
echo "stopped keeper seen: $(echo $found | cut -c1-60)"
kill -TERM -$W
sleep 3
LEFT=$(rtk proxy ps -eo pid,ppid,stat,args | grep -F '/home/lmas/rd/.a2-rig/u' | grep -v grep)
echo "LEFTOVER after group SIGTERM: $(echo -n "$LEFT" | grep -c .)  (stopped=$(echo "$LEFT" | awk '$3 ~ /^T/' | grep -c .))"
echo "$LEFT" | cut -c1-140 | head -8
for p in $(echo "$LEFT" | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
sleep 1
echo "after my cleanup: $(rtk proxy ps -eo args | grep -F '/home/lmas/rd/' | grep -vc grep)"
rm -rf /home/lmas/rd/.a2-rig/u*
