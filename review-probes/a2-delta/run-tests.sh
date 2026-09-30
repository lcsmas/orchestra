#!/bin/bash
# Runs the A2 test files under an isolated HOME/TMPDIR so leftover fakes are attributable to THIS run.
cd /home/lmas/.orchestra/worktrees/orchestra-silent-beetle-2c058ab8 || exit 9
export HOME=/home/lmas/rd TMPDIR=/home/lmas/rd/tmp
echo "START $(date +%T) tip=$(git rev-parse HEAD)"
for f in src/keeper/keeper.test.ts src/shared/resource-monitor.test.ts src/main/keeper-lifecycle.test.ts; do
  echo "=== $f $(date +%T)"
  /usr/bin/node --test --experimental-strip-types "$f" 2>&1 | grep -E '^# (tests|pass|fail|skipped|cancelled)|^not ok|^# Subtest: .*not ok' 
  echo "rc=${PIPESTATUS[0]}"
done
echo "END $(date +%T)"
