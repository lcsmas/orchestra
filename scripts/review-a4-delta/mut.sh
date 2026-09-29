#!/bin/bash
# usage: mut.sh <label> <file> <old> <new> [rebuild] [tests...]   (in place; byte-exact backup + cmp restore)
set -u
cd /home/lmas/.orchestra/worktrees/orchestra-nimble-orca-f302c2a1
label="$1"; file="$2"; old="$3"; new="$4"; rebuild="${5:-}"; shift 5 2>/dev/null || shift $#
tests="${*:-src/cli/run-hold.test.ts src/main/bus-run-hold.test.ts src/main/bus-liveness.test.ts src/shared/bus-liveness.test.ts src/main/bus-fencing.test.ts src/main/bus.test.ts src/cli/bus-status-no-run.test.ts src/main/bus-mirror.test.ts}"
bak="/home/lmas/rv-a4d/bak/$(echo "$file" | tr / _)"
cp -p "$file" "$bak"
OLD="$old" NEW="$new" FILE="$file" node -e '
const fs=require("fs"); const s=fs.readFileSync(process.env.FILE,"utf8"); const o=process.env.OLD;
const n=s.split(o).length-1; if(n!==1){console.log("APPLY-FAIL occurrences="+n); process.exit(3);}
fs.writeFileSync(process.env.FILE, s.replace(o, ()=>process.env.NEW));'
rc=$?
if [ $rc -ne 0 ]; then cp -p "$bak" "$file"; cmp "$bak" "$file" && echo "[$label] restored clean (apply failed)"; exit 0; fi
[ -n "$rebuild" ] && [ "$rebuild" != "-" ] && pnpm run build:cli >/dev/null 2>&1
out=$(node --test --experimental-strip-types --no-warnings $tests 2>&1)
echo "[$label] pass=$(echo "$out" | grep -E '^# pass' | awk '{print $3}') fail=$(echo "$out" | grep -E '^# fail' | awk '{print $3}')"
echo "$out" | grep -E "^\s*not ok" | head -4 | cut -c1-200
cp -p "$bak" "$file"; cmp "$bak" "$file" && echo "[$label] restored clean"
[ -n "$rebuild" ] && [ "$rebuild" != "-" ] && pnpm run build:cli >/dev/null 2>&1
exit 0
