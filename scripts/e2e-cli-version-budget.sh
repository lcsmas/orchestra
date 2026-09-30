#!/usr/bin/env bash
# #211 rig driver: rebuild what the rig EXECS (keeper + bundled runner), snapshot every live ~/.claude* with an
# INDEPENDENT tool before/after (the rig itself never points anything at them — the harness scrubs its env — but a
# green gate says nothing about what it damaged), then run the rig under an allowlisted env.
#   bash scripts/e2e-cli-version-budget.sh [--arm chain|bounded|cancel]
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 2

canary() { # symlink set + MCP server keys of every live ~/.claude* dir, hashed
  { find "$HOME" -maxdepth 1 -name '.claude*' -print0 2>/dev/null | xargs -0 -I{} find {} -maxdepth 2 -type l -printf '%p -> %l\n' 2>/dev/null | sort
    python3 - <<'PY'
import glob, json, os
for f in sorted(glob.glob(os.path.expanduser('~/.claude*/.claude.json')) + [os.path.expanduser('~/.claude.json')]):
    try:
        print(f, sorted((json.load(open(f)).get('mcpServers') or {}).keys()))
    except Exception as e:
        print(f, 'unreadable', type(e).__name__)
PY
  } | sha256sum | cut -c1-16
}

echo "rig: load $(cut -d' ' -f1 /proc/loadavg), $(free -g | awk '/Mem:/{print $7}') GB available (a load>20 or <6 GB run is timing-void)"
pnpm run build:keeper >/dev/null 2>&1 && pnpm run build:session-budget >/dev/null 2>&1 || { echo "ABORT: bundle build failed"; exit 2; }
for f in keeper.js session-budget.js; do [ -s "dist-electron/$f" ] || { echo "ABORT: dist-electron/$f missing after build"; exit 2; }; done
echo "rig: rebuilt keeper.js ($(stat -c %y dist-electron/keeper.js | cut -c12-19)) + session-budget.js ($(stat -c %y dist-electron/session-budget.js | cut -c12-19))"

before="$(canary)"
RESULT="$(mktemp "${TMPDIR:-$HOME/.cache}/cli-budget-rig-result.XXXXXX")"
env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 TERM=dumb RIG_RESULT_FILE="$RESULT" \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --import ./scripts/.r2-register.mjs \
  scripts/e2e-cli-version-budget.mjs "$@"
rc=$?
after="$(canary)"
if [ "$before" = "$after" ]; then echo "rig: live ~/.claude* canary UNCHANGED ($before)"; else echo "rig: live ~/.claude* canary CHANGED $before -> $after"; rc=1; fi
rm -f "$RESULT"
exit "$rc"
