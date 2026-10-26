#!/usr/bin/env bash
# Verifier seat 1 (#388 wave): install my UNTRACKED extension of the #400 member's driver into <repo>/scripts/ (zz-verifier-vhost.{mjs,sh}); remove them after the run.
# usage: mk-vhost.sh <repo-root>   then, from the repo root (bundles built + `pnpm run build:bus-abi` done):
#   E2E_RIG_BASE=/var/tmp/v400-$(id -u) RIG_HIDE_REAL_RUNTIME=1 /var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/zz-verifier-vhost.sh "$PWD" --arms <arm> --label x --out <dir>
# arms: vhost-sweep (250 login->logout cycles over 225..274 ms + rotation storms + ephemeral control + delete bytes) | vhost (150 cycles) | vhost-band (200 cycles over 243..250 ms) | vhost-del (delete only)
# Verdict: RED on `logout-never-resurrected-by-a-pending-promotion` = a logged-out cookie came back. `ctl/ephemeral-workspace-never-resurrects` must be GREEN (same sweep, no profile),
# `rotating-cookie-jar-ends-on-the-last-issued-value` GREEN. A GREEN run proves nothing without the positive control: mutant-promote-snapshot.sh must be RED on the same build flow.
set -euo pipefail
R="$(cd "$1" && pwd)"; HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -I - "$R" "$HERE" <<'PY'
import sys
R, V = sys.argv[1:3]
src = open(f"{R}/scripts/e2e-browser-profiles.mjs").read()
arm = open(f"{V}/vhost-arm.js.txt").read()
mark = "} catch (e) {\n  clause('rig', 'rig/completed', false,"
assert src.count(mark) == 1, src.count(mark)
out = src.replace(mark, arm + mark)
out = out.replace("flag('--arms', 'settings,attach,human,restore,delete,flush,session,cdp')", "flag('--arms', 'vhost-sweep')")
open(f"{R}/scripts/zz-verifier-vhost.mjs", "w").write(out)
sh = open(f"{R}/scripts/e2e-browser-profiles.sh").read().replace("e2e-browser-profiles.mjs", "zz-verifier-vhost.mjs")
open(f"{R}/scripts/zz-verifier-vhost.sh", "w").write(sh)
print("installed scripts/zz-verifier-vhost.{mjs,sh}")
PY
chmod +x "$R/scripts/zz-verifier-vhost.sh"
node --check "$R/scripts/zz-verifier-vhost.mjs" && echo SYNTAX_OK
