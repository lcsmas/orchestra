#!/usr/bin/env bash
# C2 #209 self-gate: does the whole-app rig SEE a cost it should see? Inject a KNOWN cost in place — one extra `git status` per workspace
# per 8 s stats tick (src/main/git.ts getDiffStats) — rebuild, run the app rig, and require spawns/min to rise by the injected amount
# (N workspaces × 7.5 ticks/min = +60/min at N=8); then restore BYTE-EXACT (cmp against the backup), rebuild clean, and prove `git status` clean.
#   bash scripts/hidden-cost/selfgate-mutant.sh      → prints CLEAN / MUTANT numbers and a PASS/FAIL verdict line
set -u
cd "$(dirname "$0")/../.."
F=src/main/git.ts
BAK="$(mktemp -d)/git.ts.bak"
cp "$F" "$BAK"
restore() { cp "$BAK" "$F"; cmp -s "$BAK" "$F" && echo "restored byte-exact: $F" || echo "RESTORE FAILED"; }
trap restore EXIT
python3 - <<'PY'
p='src/main/git.ts'
s=open(p).read()
old="  const working = await safeRaw(git, ['diff', '--numstat', 'HEAD']);\n"
assert s.count(old)==1, f'anchor matched {s.count(old)}x — mutant no longer describes the shipped code (PATTERN-GONE)'
s=s.replace(old, old+"  await safeRaw(git, ['status', '--porcelain']); // SELFGATE-MUTANT (C2 #209): one extra spawn per workspace per stats tick\n")
open(p,'w').write(s)
print('mutant applied')
PY
grep -c SELFGATE-MUTANT "$F" | sed 's/^/mutant lines in file: /'
PATH=/usr/local/bin:/usr/bin:/bin:$PATH pnpm run build:bundles >/dev/null 2>&1 || { echo "build failed"; exit 2; }
grep -l "SELFGATE-MUTANT\|\"status\",\"--porcelain\"\|'status', '--porcelain'" dist-electron/*.js | head -2 | sed 's/^/mutant present in bundle: /'
out=$(bash scripts/hidden-cost/app-idle-rig.sh --ws 8 --warm 20 --measure 120 --label selfgate-mutant 2>/dev/null | tail -1)
echo "$out" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print("rig void:", d["void"])'
d=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["out"])')
cp "$d/result.json" "${EV:-docs/research/hidden-cost-inventory/evidence}/selfgate-mutant.json"
