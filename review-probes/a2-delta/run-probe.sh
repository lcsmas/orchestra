#!/bin/bash
# usage: run-probe.sh <arm> [subject-repo]   — isolated HOME so leftovers are attributable
export HOME=/home/lmas/rd TMPDIR=/home/lmas/rd/tmp A2_HOME=/home/lmas/rd/.a2-rig/p$$
TIP=/home/lmas/.orchestra/worktrees/orchestra-silent-beetle-2c058ab8
[ -n "$2" ] && export SUBJECT_REPO="$2"
cd $TIP && /usr/bin/node --experimental-strip-types --import $TIP/scripts/.r2-register.mjs /home/lmas/rev-a2-delta/probes/probe.mjs "$1"
