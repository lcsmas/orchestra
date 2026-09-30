#!/bin/bash
export HOME=/home/lmas/rf TMPDIR=/home/lmas/rf/tmp CLAUDE_CONFIG_DIR=/home/lmas/rf/claude-scratch A2_HOME=/home/lmas/rf/.a2-rig/same
T=/home/lmas/a2f-tip; cd $T
run() { /usr/bin/node --experimental-strip-types --import $T/scripts/.r2-register.mjs $T/scripts/e2e-keeper-lifecycle.mjs "$1" 2>/dev/null | tail -1 | cut -c1-330; }
echo "solo (control): $(run l1_claim_age)"
run l1_claim_age > /home/lmas/rf/same-A.out & 
sleep 3.5
run l1_claim_age > /home/lmas/rf/same-B.out
wait
echo "A (started first, overlapped by B): $(cat /home/lmas/rf/same-A.out)"
echo "B: $(cat /home/lmas/rf/same-B.out)"
