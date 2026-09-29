#!/bin/bash
# usage: mutate.sh <label> <file> <old> <new> [rebuild-cli]
set -u
cd /home/lmas/.orchestra/worktrees/orchestra-happy-river-03b66340
label="$1"; file="$2"; old="$3"; new="$4"; rebuild="${5:-}"
bak="/home/lmas/rev-a4-scratch/bak-$(basename "$file")"
cp -p "$file" "$bak"
OLD="$old" NEW="$new" FILE="$file" node -e '
const fs=require("fs"); const s=fs.readFileSync(process.env.FILE,"utf8"); const o=process.env.OLD;
const n=s.split(o).length-1; if(n!==1){console.log("APPLY-FAIL occurrences="+n); process.exit(3);}
fs.writeFileSync(process.env.FILE, s.replace(o, ()=>process.env.NEW));'
rc=$?
if [ $rc -ne 0 ]; then cp -p "$bak" "$file"; cmp "$bak" "$file" && echo "[$label] restored clean (apply failed)"; exit 0; fi
git diff --stat -- "$file" | tail -1
[ -n "$rebuild" ] && pnpm run build:cli >/dev/null 2>&1
out=$(node --test --experimental-strip-types --no-warnings src/main/bus-liveness.test.ts src/main/bus-run-hold.test.ts src/shared/bus-liveness.test.ts src/cli/run-hold.test.ts 2>&1)
echo "[$label] pass=$(echo "$out" | grep -E '^# pass' | awk '{print $3}') fail=$(echo "$out" | grep -E '^# fail' | awk '{print $3}')"
echo "$out" | grep -E "^\s*not ok" | head -5
cp -p "$bak" "$file"; cmp "$bak" "$file" && echo "[$label] restored clean"
[ -n "$rebuild" ] && pnpm run build:cli >/dev/null 2>&1
exit 0
