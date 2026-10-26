#!/usr/bin/env bash
# Verifier seat 1: install my UNTRACKED extension of the #397 member's rig (arms thostile / tflake / tdetach) as scripts/zz-verifier-thost.{mjs,sh}; delete after the run.
# usage: mk-thost.sh <repo-root>  then  E2E_RIG_BASE=/var/tmp/v397-$(id -u) RIG_HIDE_REAL_RUNTIME=1 /var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/zz-verifier-thost.sh "$PWD" --arm thostile --out <dir>
set -euo pipefail
R="$(cd "$1" && pwd)"; HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -I - "$R" "$HERE" <<'PY'
import sys
R, V = sys.argv[1:3]
src = open(f"{R}/scripts/e2e-browser-agent-tabs.mjs").read()
arm = open(f"{V}/thost-arm.js.txt").read()
a = "const ARM_FNS = {\n"
assert src.count(a) == 1, src.count(a)
out = src.replace(a, a + arm)
b = "const ARMS = ['restart', 'open', 'switch', 'front', 'cap', 'strip', 'ownership', 'children', 'attach', 'background', 'refs'];"
assert out.count(b) == 1
out = out.replace(b, "const ARMS = ['restart', 'open', 'switch', 'front', 'cap', 'strip', 'ownership', 'children', 'attach', 'background', 'refs', 'thostile', 'tflake', 'tdetach', 'tchurn'];")
c = "...(ARM_LIST.includes('attach') ? { ORCHESTRA_CDP_TRACE: '1' } : {})"
assert out.count(c) == 1
out = out.replace(c, "...(ARM_LIST.includes('attach') || ARM_LIST.includes('tflake') || ARM_LIST.includes('tchurn') ? { ORCHESTRA_CDP_TRACE: '1' } : {})")
open(f"{R}/scripts/zz-verifier-thost.mjs", "w").write(out)
sh = open(f"{R}/scripts/e2e-browser-agent-tabs.sh").read().replace("e2e-browser-agent-tabs.mjs", "zz-verifier-thost.mjs")
open(f"{R}/scripts/zz-verifier-thost.sh", "w").write(sh)
print("installed scripts/zz-verifier-thost.{mjs,sh}")
PY
chmod +x "$R/scripts/zz-verifier-thost.sh"
node --check "$R/scripts/zz-verifier-thost.mjs" && echo SYNTAX_OK
