#!/bin/bash
# SIGKILL the rig's watchdog, then group-SIGTERM the rig while its keeper is SIGSTOPped: does anything leak? (rig-owned fakes only)
export HOME=/home/lmas/rf TMPDIR=/home/lmas/rf/tmp CLAUDE_CONFIG_DIR=/home/lmas/rf/claude-scratch A2_HOME=/home/lmas/rf/.a2-rig/wk
T=/home/lmas/a2f-tip; cd $T
setsid /usr/bin/node --experimental-strip-types --import $T/scripts/.r2-register.mjs $T/scripts/e2e-keeper-lifecycle.mjs daemon_refuses_hung > /home/lmas/rf/wd-kill.out 2>&1 &
R=$!
sleep 0.3; [ "$(ps -o pgid= -p $R | tr -d ' ')" = "$R" ] || { echo "GUARD: not group leader"; kill -TERM $R; exit 4; }
found=""; for i in $(seq 1 600); do found=$(ps -eo pid,stat,args | awk '$2 ~ /^T/ && index($0,"/home/lmas/rf/.a2-rig/wk")' | head -1); [ -n "$found" ] && break; sleep 0.1; done
[ -z "$found" ] && { echo "NO STOPPED KEEPER — VOID"; kill -TERM -$R; exit 3; }
echo "stopped keeper seen: $(echo $found | cut -c1-70)"
WD=$(rtk proxy ps -eo pid,args | grep -F 'A2_WATCHDOG' | grep -F '/home/lmas/rf/.a2-rig/wk' | grep -v grep | awk '{print $1}')
echo "watchdog pids: $WD"; [ -n "$WD" ] || { echo "NO WATCHDOG FOUND — VOID"; kill -TERM -$R; exit 5; }
for p in $WD; do kill -9 $p; done; sleep 0.5
echo "watchdog alive after kill -9: $(for p in $WD; do kill -0 $p 2>/dev/null && echo alive; done | grep -c alive)"
kill -TERM -$R; sleep 3
LEFT=$(rtk proxy ps -eo pid,ppid,stat,args | grep -F '/home/lmas/rf/.a2-rig/wk' | grep -v grep)
echo "LEFTOVER after watchdog SIGKILL + group SIGTERM: $(echo -n "$LEFT" | grep -c .)  (stopped=$(echo "$LEFT" | awk '$3 ~ /^T/' | grep -c .))"
echo "$LEFT" | cut -c1-120 | head -5
for p in $(echo "$LEFT" | awk '{print $1}'); do kill -9 $p 2>/dev/null; done; sleep 1
echo "after cleanup: $(rtk proxy ps -eo args | grep -F '/home/lmas/rf/.a2-rig/wk' | grep -vc grep)"; rm -rf /home/lmas/rf/.a2-rig/wk
