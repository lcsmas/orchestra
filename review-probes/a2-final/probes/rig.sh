#!/bin/bash
# usage: rig.sh <arm> [SUBJECT_REPO] — runs the SHIPPED rig from the tip against SUBJECT_REPO (default: tip). Isolated HOME.
export HOME=/home/lmas/rf TMPDIR=/home/lmas/rf/tmp CLAUDE_CONFIG_DIR=/home/lmas/rf/claude-scratch A2_HOME=/home/lmas/rf/.a2-rig/r$$
[ -n "$2" ] && export SUBJECT_REPO="$2"
RIGTREE=${RIGTREE:-/home/lmas/a2f-tip}
cd $RIGTREE && /usr/bin/node --experimental-strip-types --import $RIGTREE/scripts/.r2-register.mjs $RIGTREE/scripts/e2e-keeper-lifecycle.mjs "$1" 2>/dev/null | tail -1 | cut -c1-700
