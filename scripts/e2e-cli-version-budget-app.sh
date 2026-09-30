#!/usr/bin/env bash
# #211 built-app rig driver: the PACKAGED app (release/linux-arm64-unpacked) under the contained rig (own headless
# sway, marker-verified; allowlist env; scratch HOME/ORCHESTRA_HOME) with a SCRATCH CLAUDE_CONFIG_DIR — the contained
# rig defaults it to the invoker's REAL ~/.claude, which app boot would strip (incidents 2026-09-29/30), so this driver
# pins it and the inner rig refuses anything outside the scratch base. Takes ~9 min (4 boots × the real 90 s delay).
#   bash scripts/e2e-cli-version-budget-app.sh [--only s1|s2|s3|s4]      (build first: pnpm run build:bundles && electron-builder --dir)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 2
APP_DIR="${APP_DIR:-$REPO/release/linux-arm64-unpacked}"
[ -x "$APP_DIR/orchestra" ] || { echo "ABORT: $APP_DIR/orchestra missing — build the unpacked package first" >&2; exit 2; }
REAL_CLAUDE="$(readlink -f "$(command -v claude)")"
[ -x "$REAL_CLAUDE" ] || { echo "ABORT: no real claude on PATH" >&2; exit 2; }
BASE="${E2E_RIG_BASE:-$HOME/.cache/cbr-rig}"
mkdir -p "$BASE"
CFG="$BASE/cfg-$$"                       # SCRATCH — never a ~/.claude* dir
case "$(realpath -m "$CFG")" in "$HOME"/.claude*|"$HOME"/.orchestra*) echo "ABORT: scratch config dir resolves into a live dir" >&2; exit 2;; esac

canary() { # symlink set + MCP keys of every live ~/.claude* dir (independent of the rig's own guard)
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
echo "app rig: load $(cut -d' ' -f1 /proc/loadavg), $(free -g | awk '/Mem:/{print $7}') GB available (load>20 or <6 GB = timing-void)"
before="$(canary)"
E2E_RIG_BASE="$BASE" CLAUDE_CONFIG_DIR_PIN="$CFG" bash scripts/e2e-contained-rig.sh \
  node scripts/e2e-cli-version-budget-app.mjs "$APP_DIR" "$REAL_CLAUDE" "$HOME" "$@"
rc=$?
after="$(canary)"
if [ "$before" = "$after" ]; then echo "app rig: live ~/.claude* canary UNCHANGED ($before)"; else echo "app rig: live ~/.claude* canary CHANGED $before -> $after"; rc=1; fi
exit "$rc"
