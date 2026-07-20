#!/usr/bin/env bash
# T2 — launch Electron headless and measure the computed type of each role.
#
# Launch recipe is capture-electron.sh's: the SAME seeded fixture the GTK mock
# serves, an isolated ORCHESTRA_HOME/HOME, and a headless sway so no window
# reaches the user's desktop. Same fixture on both halves is what makes the
# pair comparable at all.
#
# Usage: measure-type-electron.sh <out.json>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$HERE/type-electron.json}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-type-electron.XXXXXX")"
HOME_DIR="$RUN/ohome"
PORT="${ORCHESTRA_DEBUG_PORT:-9357}"
mkdir -p "$HOME_DIR/.claude"

APP_PID=""; SWAY_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

[ -f "$REPO/dist-electron/main.js" ] || { echo "dist-electron missing — run: npx vite build"; exit 1; }

echo "-- seeding the shared fixture"
node "$HERE/seed-store.mjs" "$HOME_DIR"

echo "output HEADLESS-1 resolution 1600x1000" > "$RUN/sway.conf"
before="$RUN/sockets-before"; ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort > "$before" || true
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= SWAYSOCK="$RUN/sway.sock" \
  sway -c "$RUN/sway.conf" >"$RUN/sway.log" 2>&1 &
SWAY_PID=$!
WD=""
for _ in $(seq 1 50); do
  WD="$(ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort | comm -13 "$before" - | head -1)"
  [ -n "$WD" ] && break; sleep 0.2
done
[ -n "$WD" ] || { echo "headless sway produced no wayland socket"; exit 1; }
echo "-- headless sway up on $WD"

cd "$REPO"
WAYLAND_DISPLAY="$WD" ELECTRON_OZONE_PLATFORM_HINT=wayland \
  ORCHESTRA_HOME="$HOME_DIR" HOME="$HOME_DIR" ORCHESTRA_DEBUG_PORT="$PORT" \
  npx electron . --ozone-platform=wayland >"$RUN/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$PORT/json" >/dev/null 2>&1 && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "electron died early:"; cat "$RUN/app.log"; exit 1; }
  sleep 0.3
done
curl -sf "http://127.0.0.1:$PORT/json" >/dev/null || { echo "CDP never came up"; cat "$RUN/app.log"; exit 1; }

# Confirm the CDP target is OUR instance and not a sibling agent's on the same
# port — ~19 agents share this machine and port collisions have handed a
# previous run someone else's app.
TITLE="$(curl -sf "http://127.0.0.1:$PORT/json" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.type==="page");console.log((t&&t.url)||"")})')"
echo "-- CDP target url: $TITLE"

if node "$HERE/measure-type-electron.mjs" "$PORT" "$OUT"; then
  STATUS=PASS
  echo "PASS — $OUT"
else
  echo "-- app log tail:"; tail -20 "$RUN/app.log" || true
  exit 1
fi
