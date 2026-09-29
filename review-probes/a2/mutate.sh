#!/bin/zsh
# usage: mutate.sh <name> <python-replace-old> <python-replace-new>
set -u
REPO=/home/lmas/rev-a2-cand
SRC=$REPO/src/keeper/index.ts
BK=/home/lmas/rev-a2-probes/index.ts.bak
name=$1; old=$2; new=$3
cp -p $SRC $BK
cmp -s $SRC $BK || { echo "BACKUP MISMATCH"; exit 9; }
OLD="$old" NEW="$new" python3 - <<'PY'
import os
p='/home/lmas/rev-a2-cand/src/keeper/index.ts'
s=open(p).read()
o=os.environ['OLD']; n=os.environ['NEW']
assert s.count(o)==1, ('pattern count', s.count(o))
open(p,'w').write(s.replace(o,n))
PY
[ $? -eq 0 ] || { cp -p $BK $SRC; echo "PATTERN FAIL $name"; exit 8; }
diff <(cat $BK) $SRC | head -6
(cd $REPO && node node_modules/vite/bin/vite.js build --config vite.keeper.config.ts >/dev/null 2>&1; echo build_rc=$?)
echo "--- unit keeper.test.ts (mutant $name)"
(cd $REPO && node --experimental-strip-types --test src/keeper/keeper.test.ts 2>&1 | grep -E '^# (pass|fail)|^not ok' | head -8)
echo "--- rig arms (mutant $name)"
for arm in daemon_refuses_second exit_owns_only survivor_killable race_n_starts; do
  ( cd $REPO && A2_HOME=/home/lmas/rp/mut-$name node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-keeper-lifecycle.mjs $arm 2>/dev/null | tail -1 | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print('$arm', 'ok=',d.get('ok'))" ) &
done
wait
echo "--- my probes (mutant $name)"
for arm in unlink_fallback_pidless stopped_keeper; do
  ( cd /home/lmas/rev-a2-probes && SUBJECT_REPO=$REPO A2_HOME=/home/lmas/rp/mutp-$name node --experimental-strip-types --import $REPO/scripts/.r2-register.mjs probe.mjs $arm 2>/dev/null | tail -1 | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print('$arm', 'ok=',d.get('ok'), {k:d[k] for k in ('caseA','caseB','d2Exited','stole') if k in d})" ) &
done
wait
cp -p $BK $SRC
cmp $SRC $BK && echo "RESTORED $name (cmp clean)"
(cd $REPO && git status --porcelain src | head -3; node node_modules/vite/bin/vite.js build --config vite.keeper.config.ts >/dev/null 2>&1; echo rebuild_rc=$?)
