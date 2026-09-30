#!/bin/bash
# usage: runmut.sh M1 M2 ...   (M=CLEAN runs the unmutated control). Sequential; result lines -> /home/lmas/rf/mut-summary.txt
export HOME=/home/lmas/rf TMPDIR=/home/lmas/rf/tmp CLAUDE_CONFIG_DIR=/home/lmas/rf/claude-scratch
T=/home/lmas/a2f-mut
for m in "$@"; do
  if [ "$m" != CLEAN ]; then python3 /home/lmas/rf/probes/mut.py apply "$m" || { echo "$m APPLY-FAILED" >> /home/lmas/rf/mut-summary.txt; continue; }; fi
  (cd $T && /usr/bin/node node_modules/vite/bin/vite.js build --config vite.keeper.config.ts >/dev/null 2>&1; echo "build rc=$?" > /home/lmas/rf/mut-build.rc)
  log=/home/lmas/rf/mut-$m.log
  /home/lmas/rf/probes/wrap.sh $T $log
  pass=$(grep -E '^# pass' $log | awk '{print $3}'); fail=$(grep -E '^# fail' $log | awk '{print $3}'); sk=$(grep -E '^# skipped' $log | awk '{print $3}')
  red=$(grep -E '^not ok|^    not ok|^  not ok' $log | sed -E 's/^ *not ok [0-9]+ - //' | cut -c1-70 | tr '\n' '|')
  [ "$m" != CLEAN ] && python3 /home/lmas/rf/probes/mut.py restore "$m"
  echo "$m pass=$pass fail=$fail skipped=$sk red=[$red] $(cat /home/lmas/rf/mut-build.rc)" >> /home/lmas/rf/mut-summary.txt
done
echo "RUNMUT DONE $*" >> /home/lmas/rf/mut-summary.txt
