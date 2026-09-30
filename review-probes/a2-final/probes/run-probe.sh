#!/bin/bash
# usage: run-probe.sh <arm> [subject-repo]  — isolated HOME /home/lmas/rf so leftovers are attributable
export HOME=/home/lmas/rf TMPDIR=/home/lmas/rf/tmp A2_HOME=/home/lmas/rf/.a2-rig/p$$ CLAUDE_CONFIG_DIR=/home/lmas/rf/claude-scratch
TIP=/home/lmas/a2f-tip
[ -n "$2" ] && export SUBJECT_REPO="$2"
cd $TIP && /usr/bin/node --experimental-strip-types --import $TIP/scripts/.r2-register.mjs /home/lmas/rf/probes/probe.mjs "$1"
