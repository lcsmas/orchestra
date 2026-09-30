#!/bin/bash
# usage: rigp4.sh <arm> [SUBJECT_REPO]  — the P4 rig copy (in a2f-mut/scripts) against SUBJECT (default a2f-mut)
export HOME=/home/lmas/rf TMPDIR=/home/lmas/rf/tmp CLAUDE_CONFIG_DIR=/home/lmas/rf/claude-scratch A2_HOME=/home/lmas/rf/.a2-rig/q$$
[ -n "$2" ] && export SUBJECT_REPO="$2"
T=/home/lmas/a2f-mut; cd $T && /usr/bin/node --experimental-strip-types --import $T/scripts/.r2-register.mjs $T/scripts/rig-p4.mjs "$1" 2>/dev/null | tail -1 | cut -c1-600
