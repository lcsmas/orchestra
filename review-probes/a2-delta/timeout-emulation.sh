#!/bin/bash
# Emulate execFile's 240 s timeout: SIGTERM ONE arm's rig node while its keeper is SIGSTOPped; the wrapper survives.
export HOME=/home/lmas/rd TMPDIR=/home/lmas/rd/tmp
TIP=/home/lmas/.orchestra/worktrees/orchestra-silent-beetle-2c058ab8
cd $TIP
/usr/bin/node --test --experimental-strip-types src/main/keeper-lifecycle.test.ts > /home/lmas/rev-a2-delta/timeout-emu.tap 2>&1 &
W=$!
echo "wrapper pid=$W"
victim=""
for i in $(seq 1 600); do
  stopped=$(ps -eo pid,stat,args | awk '$2 ~ /^T/ && index($0,"/home/lmas/rd/.a2-rig/u")' | head -1)
  if [ -n "$stopped" ]; then
    # find the rig node (parent chain): the process running scripts/e2e-keeper-lifecycle.mjs for the arm whose dir the stopped keeper lives in
    dir=$(echo "$stopped" | grep -oE '/home/lmas/rd/.a2-rig/u[0-9]+/[0-9a-f]{8}' | head -1)
    for rp in $(pgrep -f 'e2e-keeper-lifecycle.mjs'); do
      if tr '\0' '\n' < /proc/$rp/environ 2>/dev/null | grep -q "^A2_HOME=$(dirname $dir)\$"; then
        arm=$(tr '\0' ' ' < /proc/$rp/cmdline | awk '{print $NF" "$(NF-1)}')
        # the rig's own base dir is A2_HOME/<sha1(arm)[:8]>; only kill the rig whose base == dir
        b=$(echo -n "$(tr '\0' ' ' < /proc/$rp/cmdline | awk '{print $NF}' | sed 's/ *$//')" | sha1sum | cut -c1-8)
        if [ "$dir" = "$(dirname $dir)/$b" ]; then victim=$rp; break; fi
      fi
    done
    [ -n "$victim" ] && break
  fi
  sleep 0.1
done
if [ -z "$victim" ]; then echo "NO VICTIM FOUND (probe VOID)"; else
  echo "SIGTERM rig pid=$victim ($(tr '\0' ' ' < /proc/$victim/cmdline | awk '{print $NF}')) while its keeper is SIGSTOPped"
  kill -TERM $victim
fi
wait $W; echo "wrapper rc=$?"
grep -E '^# (tests|pass|fail|skipped)|^not ok' /home/lmas/rev-a2-delta/timeout-emu.tap | cut -c1-150
echo "LEFTOVER under isolated HOME after wrapper exit (proxy ps): $(rtk proxy ps -eo args | grep -F '/home/lmas/rd/' | grep -vc grep)"
