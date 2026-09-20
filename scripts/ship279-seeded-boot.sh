#!/usr/bin/env bash
# ship v0.5.279 gate 2 addendum: prove the packaged app logs "loaded N workspace(s)"
# with N>=1 by SEEDING a store.json at the documented path
# ($ORCHESTRA_HOME/userData/orchestra/store.json) before boot.
# Own headless sway, magenta marker, env -i allowlist, DISPLAY unset.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE="$ROOT/release/Orchestra.AppImage"
RIG_ROOT="${ORCHESTRA_HOME_REAL:-$HOME/.orchestra}"
WORK="$(mktemp -d "$RIG_ROOT/ship279-seedboot-XXXXXX")"
HOME_DIR="$WORK/home"
STORE="$HOME_DIR/.orchestra/userData/orchestra/store.json"
mkdir -p "$(dirname "$STORE")"
cat > "$STORE" <<'JSON'
{"repos":[{"path":"/tmp/seed-repo","name":"seed-repo"}],
 "workspaces":[{"id":"seed-ws-1","name":"seed-ws","kind":"workspace","repoPath":"/tmp/seed-repo","worktreePath":"/tmp/seed-repo","branch":"main","baseBranch":"main","createdAt":"2026-09-21T00:00:00.000Z","status":"idle","agent":"claude"}],
 "accounts":[],"selfTuneRuns":[],"tickets":[],"linkBackfillVersion":0,"busSwitches":{}}
JSON
echo "[seed] store written: $STORE ($(wc -c < "$STORE") bytes, workspaces=1)"

fail(){ echo "FAIL: $*" >&2; teardown; exit 1; }
SWAY_PID=""; APP_PID=""; CFG=""
teardown(){ [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null; [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null; [ -n "$CFG" ] && rm -f "$CFG"; }
trap teardown EXIT

# 1. start compositor
CFG="$(mktemp)"; echo 'output HEADLESS-1 resolution 1600x1000' > "$CFG"
before="$(ls /run/user/$(id -u)/wayland-* 2>/dev/null)"
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= \
  SWAYSOCK="$WORK/sway.sock" sway -c "$CFG" >"$WORK/sway.log" 2>&1 &
SWAY_PID=$!
for i in $(seq 1 40); do [ -S "$WORK/sway.sock" ] && break; sleep 0.25; done
[ -S "$WORK/sway.sock" ] || fail "sway socket never appeared"

# 2. unique marker per rig
MR="FF"; MG="$(printf '%02X' $(( ($$ / 251) % 256 )))"; MB="$(printf '%02X' $(( $$ % 251 + 5 )))"
MARK="$MR$MG$MB"
SWAYSOCK="$WORK/sway.sock" swaymsg -- "output HEADLESS-1 background #$MARK solid_color" >/dev/null 2>&1
sleep 0.5
MY_DISPLAY=""
count100=0
for n in 1 2 3 4 5 6 7 8; do
  WAYLAND_DISPLAY=wayland-$n grim -o HEADLESS-1 "$WORK/m-$n.png" 2>/dev/null || continue
  pct="$(python3 - "$WORK/m-$n.png" "$MR" "$MG" "$MB" <<'PY'
import sys
from PIL import Image
img=Image.open(sys.argv[1]).convert("RGB")
r,g,b=int(sys.argv[2],16),int(sys.argv[3],16),int(sys.argv[4],16)
px=list(img.getdata()); tot=len(px)
hit=sum(1 for p in px if p==(r,g,b))
print(round(100*hit/tot))
PY
)"
  if [ "$pct" = "100" ]; then MY_DISPLAY="wayland-$n"; count100=$((count100+1)); fi
done
[ "$count100" -eq 1 ] || fail "expected exactly one 100% marker socket, got $count100 (collision or none)"
echo "[rig] my display = $MY_DISPLAY (marker #$MARK, exactly one 100% match)"

# 3. preflight FAIL CLOSED
[ -n "$MY_DISPLAY" ] || fail "no display captured"
[ -z "${DISPLAY:-}" ] || fail "X11 DISPLAY leaks to human"

# 4. boot the seeded home
APPLOG="$HOME_DIR/.orchestra/logs/orchestra.log"
env -i \
  HOME="$HOME_DIR" \
  PATH=/usr/bin:/bin \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
  WAYLAND_DISPLAY="$MY_DISPLAY" \
  ELECTRON_OZONE_PLATFORM_HINT=wayland \
  ORCHESTRA_HOME="$HOME_DIR/.orchestra" \
  "$APPIMAGE" --ozone-platform=wayland --no-sandbox \
  >"$WORK/app.stdout" 2>&1 &
APP_PID=$!
waited=0
while [ "$waited" -lt 240 ]; do
  if [ -f "$APPLOG" ] && grep -qE 'loaded [0-9]+ workspace' "$APPLOG" 2>/dev/null; then break; fi
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.5; waited=$((waited+1))
done
sleep 1
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""

echo "=== workspace-load lines ==="
grep -E 'loaded [0-9]+ workspace' "$APPLOG" 2>/dev/null || { echo "(none)"; tail -20 "$APPLOG" 2>/dev/null; fail "no workspace-load line"; }
LINE="$(grep -E '\[store\] loaded [0-9]+ workspace' "$APPLOG" 2>/dev/null | grep -vE 'loaded 0 workspace' | head -1)"
if [ -n "$LINE" ]; then
  echo "PASS: seeded store → $LINE"
  echo "KEPT: $WORK"
  trap - EXIT; teardown
  exit 0
else
  fail "workspace-load line present but N=0 despite seeded store"
fi
